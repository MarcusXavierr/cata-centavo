import type { z } from "zod";

import type { Bank, Clock, Connection, Logger, RefreshStart, Sleep } from "../core/contracts.ts";
import type { Credentials } from "../config.ts";
import { AuthError, HttpError, NotFoundError, PluggyError, RateLimitError, ResponseShapeError } from "./errors.ts";
import { toConnection } from "./mapper.ts";
import { API_ERROR, AUTH_RESPONSE, ITEM, refusesManualUpdate, UPDATE_REFUSED } from "./wire.ts";

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export type RateLimiter = {
  acquire(): Promise<void>;
};

/**
 * How early we stop trusting the key. Pluggy's `apiKey` lives two hours, and
 * expiring at its full lifetime means a token with milliseconds left passes the
 * check and the request 401s anyway — which is exactly what `pluggy-sdk` does
 * (`payload.exp <= now` in its `isJwtExpired`). ADR §15 Phase 0.
 */
export const KEY_MARGIN_MS = 10 * 60 * 1000;

/** Used only when the key is not a JWT we can read an `exp` out of. */
const KEY_FALLBACK_LIFETIME_MS = 2 * 60 * 60 * 1000;

/**
 * Disputed: the project spec says 360/min per IP, the prior Go implementation
 * hardcodes 360 per *hour*, and ADR Phase 0.5 step 4 exists to settle which.
 * Until it does, this errs high, because guessing too high costs a 429 and a
 * retry while guessing too low makes the Phase 1 fan-out crawl and look broken.
 */
export const RATE_LIMIT = { requests: 360, windowMs: 60_000 } as const;

/**
 * `PATCH /items` is an order of magnitude tighter than everything else — 20 a
 * minute against 360 — because Pluggy means it for user-triggered refreshes and
 * says so in the same breath. One shared window would let a fan-out of reads
 * spend a budget the updates need.
 */
export const UPDATE_RATE_LIMIT = { requests: 20, windowMs: 60_000 } as const;

/** How many times a 429 is worth waiting out before it becomes the caller's problem. */
export const RATE_LIMIT_RETRIES = 2;

/** What Pluggy's `Retry-After` says when it says nothing: their docs always send 60. */
const RETRY_AFTER_FALLBACK_MS = 60_000;

const DEFAULT_BASE_URL = "https://api.pluggy.ai";

export type PluggyClientOptions = {
  readonly credentials: Credentials;
  readonly clock: Clock;
  readonly fetch: Fetch;
  readonly limiter?: RateLimiter;
  readonly updateLimiter?: RateLimiter;
  readonly sleep?: Sleep;
  readonly log: Logger;
  readonly baseUrl?: string;
};

/**
 * The Pluggy client, written rather than taken from `pluggy-sdk`.
 *
 * The SDK resolves the key lazily and checks the JWT already, so the ADR's
 * original complaint does not apply to it. What it has no way to offer is a
 * margin, a single-flight, a 401 retry or a rate limiter, because the key cache
 * is private instance state and the send function is not ours. ADR §15 Phase 0
 * records the whole comparison.
 *
 * Construction performs no I/O. A bad credential has to be reportable by
 * `init`, and `init` cannot report a condition that already killed the process
 * (§16.2).
 */
export function createPluggyClient(options: PluggyClientOptions): Bank {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const limiter = options.limiter ?? slidingWindowLimiter(options.clock);
  const updateLimiter =
    options.updateLimiter ??
    slidingWindowLimiter(options.clock, UPDATE_RATE_LIMIT.requests, UPDATE_RATE_LIMIT.windowMs);
  const sleep = options.sleep ?? delay;

  let key: { readonly value: string; readonly expiresAt: number } | null = null;
  let refreshing: Promise<string> | null = null;

  /**
   * The single send function. Everything reaching Pluggy passes through here,
   * so the rate limiter cannot be forgotten by a new endpoint — the bug §16.2
   * found wired to two of nine call sites. Both windows are claimed here for the
   * same reason.
   */
  async function transport(
    method: string,
    path: string,
    extras: { readonly apiKey?: string; readonly body?: unknown },
  ): Promise<Response> {
    if (triggersUpdate(method, path)) {
      await updateLimiter.acquire();
    }
    await limiter.acquire();

    const headers: Record<string, string> = { "content-type": "application/json" };
    if (extras.apiKey !== undefined) {
      headers["X-API-KEY"] = extras.apiKey;
    }

    const init: RequestInit = { method, headers };
    if (extras.body !== undefined) {
      init.body = JSON.stringify(extras.body);
    }

    return options.fetch(`${baseUrl}${path}`, init);
  }

  async function authenticate(): Promise<string> {
    const response = await transport("POST", "/auth", { body: options.credentials });

    if (!response.ok) {
      throw classify(response.status, "authenticating");
    }

    return parse(AUTH_RESPONSE, await readJson(response), "the /auth response").apiKey;
  }

  /**
   * Resolved lazily per request and cached, guarded by a single-flight so the
   * account fan-out of §14.1 cannot issue N concurrent `POST /auth`.
   */
  async function resolveKey(force = false): Promise<string> {
    const now = options.clock.now().getTime();

    if (!force && key !== null && now < key.expiresAt) {
      return key.value;
    }

    refreshing ??= authenticate()
      .then((value) => {
        key = { value, expiresAt: expiryOf(value, now) };
        return value;
      })
      .finally(() => {
        refreshing = null;
      });

    return refreshing;
  }

  /**
   * An authenticated request, with the key renewed once on a 401 and a 429 waited
   * out for as long as Pluggy asks. Returns the response rather than throwing on
   * it, because `refreshConnection` needs to read a 409 as an answer.
   *
   * Replaying a `PATCH` after either status is safe: both mean it never ran.
   */
  async function authorized(method: string, path: string, body?: unknown): Promise<Response> {
    let response = await transport(method, path, { apiKey: await resolveKey(), body });

    if (response.status === 401) {
      response = await transport(method, path, { apiKey: await resolveKey(true), body });
    }

    for (let retry = 0; retry < RATE_LIMIT_RETRIES && response.status === 429; retry += 1) {
      options.log.warn(
        { method, path, attempt: retry + 1, maxRetries: RATE_LIMIT_RETRIES },
        "rate limit response; retrying",
      );
      await sleep(retryAfterMs(response));
      response = await transport(method, path, { apiKey: await resolveKey(), body });
    }

    return response;
  }

  async function send<T>(
    method: string,
    path: string,
    schema: z.ZodType<T>,
    describe: string,
    body?: unknown,
  ): Promise<T> {
    const response = await authorized(method, path, body);

    if (!response.ok) {
      throw await failureFor(response, describe);
    }

    return parse(schema, await readJson(response), describe);
  }

  return {
    verifyCredentials: async () => {
      await resolveKey();
    },

    getConnection: async (id: string): Promise<Connection> => {
      const item = await send("GET", `/items/${encodeURIComponent(id)}`, ITEM, `connection ${id}`);
      return toConnection(item);
    },

    refreshConnection: async (id: string): Promise<RefreshStart> => {
      const path = `/items/${encodeURIComponent(id)}`;
      const response = await authorized("PATCH", path, {});

      if (response.status === 409) {
        return refusal(await readRefusal(response));
      }

      if (!response.ok) {
        // The body is readable once, so the detail is read before it is judged:
        // a 400 saying the connector has no on-demand update is an answer, and
        // every other 400 keeps that same detail in its message.
        const detail = await readErrorDetail(response);

        if (response.status === 400 && refusesManualUpdate(detail)) {
          return { kind: "not-refreshable" };
        }

        throw classify(response.status, `refreshing connection ${id}`, detail);
      }

      const item = parse(ITEM, await readJson(response), `connection ${id}`);
      return { kind: "started", connection: toConnection(item) };
    },
  };
}

/** Only `PATCH /items/{id}` spends the update budget. */
function triggersUpdate(method: string, path: string): boolean {
  return method === "PATCH" && path.startsWith("/items/");
}

function retryAfterMs(response: Response): number {
  const header = response.headers.get("retry-after");
  const seconds = header === null ? Number.NaN : Number(header);

  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : RETRY_AFTER_FALLBACK_MS;
}

/**
 * A 409 means the last sync is too recent, which is the debounce of ADR §11 and
 * an answer rather than a failure. A body we cannot read is still that answer, so
 * nothing here throws.
 */
async function readRefusal(response: Response): Promise<z.infer<typeof UPDATE_REFUSED> | null> {
  try {
    const parsed = UPDATE_REFUSED.safeParse(await response.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function refusal(body: z.infer<typeof UPDATE_REFUSED> | null): RefreshStart {
  const lastUpdatedAt = body?.data?.lastUpdatedAt;

  return {
    kind: "too-soon",
    everyHours: body?.data?.minUpdateFrequencyAllowedInHours ?? null,
    lastUpdatedAt: lastUpdatedAt === null || lastUpdatedAt === undefined ? null : new Date(lastUpdatedAt),
  };
}

/**
 * Which failure this is, decided once. §16.4 requires choosing per case between
 * a protocol error and readable tool content, and that choice needs these to be
 * distinguishable rather than a status code inside a message.
 */
function classify(status: number, describe: string, detail: string | null = null): PluggyError {
  const because = detail === null ? "" : ` — ${detail}`;

  if (status === 401 || status === 403) {
    return new AuthError(`Pluggy refused the request while ${describe} — check PLUGGY_CLIENT_ID and PLUGGY_CLIENT_SECRET`, status);
  }
  if (status === 404) {
    return new NotFoundError("not found — wrong id, or an id belonging to another Pluggy account", status);
  }
  if (status === 429) {
    return new RateLimitError(`Pluggy rate limited the request while ${describe}`, status);
  }
  return new HttpError(`Pluggy returned ${status} while ${describe}${because}`, status);
}

/**
 * The failure with Pluggy's own explanation attached, when it gave one. A 404
 * already has a better sentence than Pluggy's, so that one keeps ours.
 */
async function failureFor(response: Response, describe: string): Promise<PluggyError> {
  return classify(response.status, describe, response.status === 404 ? null : await readErrorDetail(response));
}

async function readErrorDetail(response: Response): Promise<string | null> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return null;
  }

  const parsed = API_ERROR.safeParse(body);
  if (!parsed.success) {
    return null;
  }

  const { codeDescription, message, data } = parsed.data;
  const retry = data?.canRetryAfterDate;
  const parts = [
    codeDescription ?? null,
    message ?? null,
    retry === null || retry === undefined ? null : `retry after ${retry}`,
  ];

  const detail = parts.filter((part) => part !== null).join(": ");
  return detail === "" ? null : detail;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new ResponseShapeError("Pluggy returned a body that is not JSON", response.status);
  }
}

function parse<T>(schema: z.ZodType<T>, body: unknown, describe: string): T {
  const result = schema.safeParse(body);

  if (!result.success) {
    const where = result.error.issues.map((issue) => issue.path.join(".") || "(root)").join(", ");
    throw new ResponseShapeError(`${describe} did not match the shape we expect, at: ${where}`);
  }

  return result.data;
}

function expiryOf(token: string, now: number): number {
  return (jwtExpiry(token) ?? now + KEY_FALLBACK_LIFETIME_MS) - KEY_MARGIN_MS;
}

/** Reads `exp` out of a JWT without a library. Returns null for anything else. */
function jwtExpiry(token: string): number | null {
  const payload = token.split(".")[1];
  if (payload === undefined) {
    return null;
  }

  try {
    const decoded: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (typeof decoded === "object" && decoded !== null && "exp" in decoded) {
      const { exp } = decoded as { readonly exp: unknown };
      if (typeof exp === "number") {
        return exp * 1000;
      }
    }
  } catch {
    return null;
  }

  return null;
}

const delay: Sleep = (milliseconds) =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

/**
 * Waits rather than rejecting, because a caller that is merely early should not
 * have to know about the limit.
 */
export function slidingWindowLimiter(
  clock: Clock,
  limit: number = RATE_LIMIT.requests,
  windowMs: number = RATE_LIMIT.windowMs,
  sleep: Sleep = delay,
): RateLimiter {
  let hits: readonly number[] = [];

  return {
    acquire: async () => {
      for (;;) {
        const now = clock.now().getTime();
        hits = hits.filter((at) => now - at < windowMs);

        if (hits.length < limit) {
          hits = [...hits, now];
          return;
        }

        const oldest = hits[0];
        await sleep(oldest === undefined ? windowMs : oldest + windowMs - now);
      }
    },
  };
}

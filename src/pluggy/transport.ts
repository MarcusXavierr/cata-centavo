import type { Clock, Logger, Sleep } from "../core/contracts.ts";
import type { Credentials } from "../config.ts";
import { classify, parse, readJson } from "./errors.ts";
import { AUTH_RESPONSE } from "./wire.ts";

/**
 * Everything between us and Pluggy's HTTP: the two rate-limit windows, the API
 * key and its renewal, and the retries that belong to the wire rather than to
 * any endpoint.
 *
 * It is a module of its own so that `client.ts` can be about connections. The
 * split also keeps the promise §16.2 asks for readable: there is one function
 * that sends, it is private to this file, and a new endpoint cannot reach the
 * network around it.
 */

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

export type TransportOptions = {
  readonly credentials: Credentials;
  readonly clock: Clock;
  readonly fetch: Fetch;
  readonly limiter?: RateLimiter;
  readonly updateLimiter?: RateLimiter;
  readonly sleep?: Sleep;
  readonly log: Logger;
  readonly baseUrl?: string;
};

export type Transport = {
  /** The API key, resolved on first use and cached. `verifyCredentials` is this and nothing else. */
  key(): Promise<string>;
  /**
   * An authenticated request, with the key renewed once on a 401 and a 429 waited
   * out for as long as Pluggy asks. Returns the response rather than throwing on
   * it, because `refreshConnection` needs to read a 409 as an answer.
   *
   * Replaying a `PATCH` after either status is safe: both mean it never ran.
   */
  authorized(method: string, path: string, body?: unknown): Promise<Response>;
};

/**
 * Construction performs no I/O. A bad credential has to be reportable by
 * `init`, and `init` cannot report a condition that already killed the process
 * (§16.2).
 */
export function createTransport(options: TransportOptions): Transport {
  const send = sender(options);
  const key = keyResolver(options, send);
  const sleep = options.sleep ?? delay;

  async function authorized(method: string, path: string, body?: unknown): Promise<Response> {
    let response = await send(method, path, { apiKey: await key(), body });

    if (response.status === 401) {
      response = await send(method, path, { apiKey: await key(true), body });
    }

    for (let retry = 0; retry < RATE_LIMIT_RETRIES && response.status === 429; retry += 1) {
      options.log.warn(
        { method, path, attempt: retry + 1, maxRetries: RATE_LIMIT_RETRIES },
        "rate limit response; retrying",
      );
      await sleep(retryAfterMs(response));
      response = await send(method, path, { apiKey: await key(), body });
    }

    return response;
  }

  return { key: () => key(), authorized };
}

type Send = (
  method: string,
  path: string,
  extras: { readonly apiKey?: string; readonly body?: unknown },
) => Promise<Response>;

/**
 * The single send function. Everything reaching Pluggy passes through here, so
 * the rate limiter cannot be forgotten by a new endpoint — the bug §16.2 found
 * wired to two of nine call sites. Both windows are claimed here for the same
 * reason.
 */
function sender(options: TransportOptions): Send {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const limiter = options.limiter ?? slidingWindowLimiter(options.clock);
  const updateLimiter =
    options.updateLimiter ??
    slidingWindowLimiter(options.clock, UPDATE_RATE_LIMIT.requests, UPDATE_RATE_LIMIT.windowMs);

  return async (method, path, extras) => {
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
  };
}

type KeyResolver = (force?: boolean) => Promise<string>;

/**
 * The key, resolved lazily per request and cached, guarded by a single-flight so
 * the account fan-out of §14.1 cannot issue N concurrent `POST /auth`.
 */
function keyResolver(options: TransportOptions, send: Send): KeyResolver {
  let key: { readonly value: string; readonly expiresAt: number } | null = null;
  let refreshing: Promise<string> | null = null;

  async function authenticate(): Promise<string> {
    const response = await send("POST", "/auth", { body: options.credentials });

    if (!response.ok) {
      throw classify(response.status, "authenticating");
    }

    return parse(AUTH_RESPONSE, await readJson(response), "the /auth response").apiKey;
  }

  return async (force = false) => {
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

function expiryOf(token: string, now: number): number {
  return (jwtExpiry(token) ?? now + KEY_FALLBACK_LIFETIME_MS) - KEY_MARGIN_MS;
}

/** Reads `exp` out of a JWT without a library. Returns null for anything else. */
function jwtExpiry(token: string): number | null {
  const exp = jwtPayload(token)?.["exp"];

  return typeof exp === "number" ? exp * 1000 : null;
}

function jwtPayload(token: string): Record<string, unknown> | null {
  const encoded = token.split(".")[1];
  if (encoded === undefined) {
    return null;
  }

  try {
    const decoded: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    return typeof decoded === "object" && decoded !== null ? (decoded as Record<string, unknown>) : null;
  } catch {
    return null;
  }
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

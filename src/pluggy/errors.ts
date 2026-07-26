import type { z } from "zod";

import type { BankFailure, FailureKind } from "../core/contracts.ts";
import { API_ERROR } from "./wire.ts";

/**
 * Typed failures from the Pluggy boundary, and the translation from a response
 * into one of them.
 *
 * They exist because ADR §16.4 requires deciding *per failure* between a
 * protocol error and readable `isError` tool content, and that decision needs
 * something to switch on. Anything the model should recover from — a revoked
 * consent, an unknown connection — has to arrive as a distinguishable type
 * rather than as a status code buried in a string.
 *
 * The translation lives here rather than beside either caller because both the
 * transport and the client need it: a refused `POST /auth` and a refused
 * `GET /items/{id}` are the same failure wearing different sentences.
 *
 * No constructor here performs I/O and nothing calls `process.exit` (§16.2).
 */

export class PluggyError extends Error {
  readonly status: number | undefined;
  readonly kind: FailureKind;

  constructor(message: string, kind: FailureKind, status?: number) {
    super(message);
    this.name = new.target.name;
    this.kind = kind;
    this.status = status;
  }
}

/** Credentials refused, or a key that could not be renewed. */
export class AuthError extends PluggyError {
  constructor(message: string, status?: number) {
    super(message, "auth", status);
  }
}

/** The resource does not exist, or belongs to another Pluggy account. */
export class NotFoundError extends PluggyError {
  constructor(message: string, status?: number) {
    super(message, "unknown-connection", status);
  }
}

/** Rate limited. Recoverable by waiting; see the limiter in `transport.ts`. */
export class RateLimitError extends PluggyError {
  constructor(message: string, status?: number) {
    super(message, "rate-limited", status);
  }
}

/** Any other non-2xx response. */
export class HttpError extends PluggyError {
  constructor(message: string, status?: number) {
    super(message, "unavailable", status);
  }
}

/**
 * A 2xx body that does not match what we expected. Separate from `HttpError`
 * because it means Pluggy changed, not that the request was wrong — the case
 * Phase 0.5 step 5 warns about, where trusting a shape we never checked deletes
 * the evidence before a human sees it.
 */
export class ResponseShapeError extends PluggyError {
  constructor(message: string, status?: number) {
    super(message, "bad-response", status);
  }
}

/** Turns a thrown boundary error into the core's portable failure contract. */
export function toFailure(error: unknown): BankFailure {
  if (error instanceof PluggyError) {
    return { kind: error.kind, message: error.message };
  }

  return { kind: "unavailable", message: String(error) };
}

/**
 * Which failure this is, decided once. §16.4 requires choosing per case between
 * a protocol error and readable tool content, and that choice needs these to be
 * distinguishable rather than a status code inside a message.
 */
export function classify(status: number, describe: string, detail: string | null = null): PluggyError {
  if (status === 401 || status === 403) {
    return new AuthError(`Pluggy refused the request while ${describe} — check PLUGGY_CLIENT_ID and PLUGGY_CLIENT_SECRET`, status);
  }
  if (status === 404) {
    return new NotFoundError("not found — wrong id, or an id belonging to another Pluggy account", status);
  }
  if (status === 429) {
    return new RateLimitError(`Pluggy rate limited the request while ${describe}`, status);
  }
  return new HttpError(`Pluggy returned ${status} while ${describe}${because(detail)}`, status);
}

function because(detail: string | null): string {
  return detail === null ? "" : ` — ${detail}`;
}

/**
 * The failure with Pluggy's own explanation attached, when it gave one. A 404
 * already has a better sentence than Pluggy's, so that one keeps ours.
 */
export async function failureFor(response: Response, describe: string): Promise<PluggyError> {
  return classify(response.status, describe, response.status === 404 ? null : await readErrorDetail(response));
}

export async function readErrorDetail(response: Response): Promise<string | null> {
  const parsed = API_ERROR.safeParse(await readJsonOrNull(response));

  return parsed.success ? detailOf(parsed.data) : null;
}

function detailOf(error: z.infer<typeof API_ERROR>): string | null {
  const parts = [error.codeDescription, error.message, retryHint(error.data?.canRetryAfterDate)];
  const detail = parts.filter((part) => part !== null && part !== undefined).join(": ");

  return detail === "" ? null : detail;
}

function retryHint(at: string | null | undefined): string | null {
  return at === null || at === undefined ? null : `retry after ${at}`;
}

async function readJsonOrNull(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new ResponseShapeError("Pluggy returned a body that is not JSON", response.status);
  }
}

export function parse<T>(schema: z.ZodType<T>, body: unknown, describe: string): T {
  const result = schema.safeParse(body);

  if (!result.success) {
    const where = result.error.issues.map((issue) => issue.path.join(".") || "(root)").join(", ");
    throw new ResponseShapeError(`${describe} did not match the shape we expect, at: ${where}`);
  }

  return result.data;
}

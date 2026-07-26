/**
 * Typed failures from the Pluggy boundary.
 *
 * They exist because ADR §16.4 requires deciding *per failure* between a
 * protocol error and readable `isError` tool content, and that decision needs
 * something to switch on. Anything the model should recover from — a revoked
 * consent, an unknown connection — has to arrive as a distinguishable type
 * rather than as a status code buried in a string.
 *
 * No constructor here performs I/O and nothing calls `process.exit` (§16.2).
 */

export class PluggyError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = new.target.name;
    this.status = status;
  }
}

/** Credentials refused, or a key that could not be renewed. */
export class AuthError extends PluggyError {}

/** The resource does not exist, or belongs to another Pluggy account. */
export class NotFoundError extends PluggyError {}

/** Rate limited. Recoverable by waiting; see the limiter in `client.ts`. */
export class RateLimitError extends PluggyError {}

/** Any other non-2xx response. */
export class HttpError extends PluggyError {}

/**
 * A 2xx body that does not match what we expected. Separate from `HttpError`
 * because it means Pluggy changed, not that the request was wrong — the case
 * Phase 0.5 step 5 warns about, where trusting a shape we never checked deletes
 * the evidence before a human sees it.
 */
export class ResponseShapeError extends PluggyError {}

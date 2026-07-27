import type { Consent } from "./contracts.ts";

export type ConsentState = "active" | "revoked" | "expired" | "unknown";

/**
 * `revoked` outranks `expired` when both apply: revocation is an act and
 * expiry is the clock running out, and the act is what the user has to answer
 * for. `null` means the endpoint answered with no consent at all, which is
 * `unknown` rather than `revoked` — we never report revocation from absence.
 */
export function consentState(consent: Consent | null, now: Date): ConsentState {
  if (consent === null) {
    return "unknown";
  }

  if (consent.revokedAt !== null) {
    return "revoked";
  }

  if (consent.expiresAt !== null && consent.expiresAt.getTime() <= now.getTime()) {
    return "expired";
  }

  return "active";
}

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { consentState } from "../../src/core/consent.ts";
import type { Consent } from "../../src/core/contracts.ts";

const NOW = new Date("2026-07-25T12:00:00.000Z");
const PAST = new Date("2026-07-20T12:00:00.000Z");
const FUTURE = new Date("2026-08-01T12:00:00.000Z");

function consent(overrides: Partial<Consent> = {}): Consent {
  return { expiresAt: null, revokedAt: null, products: [], ...overrides };
}

describe("consentState", () => {
  const cases: readonly { readonly why: string; readonly consent: Consent | null; readonly expected: string }[] = [
    { why: "no revocation and no expiry", consent: consent(), expected: "active" },
    { why: "an expiry still in the future", consent: consent({ expiresAt: FUTURE }), expected: "active" },
    { why: "a revocation date", consent: consent({ revokedAt: PAST }), expected: "revoked" },
    { why: "an expiry in the past", consent: consent({ expiresAt: PAST }), expected: "expired" },
    { why: "both revoked and expired — revocation wins", consent: consent({ revokedAt: PAST, expiresAt: PAST }), expected: "revoked" },
    { why: "no consent at all", consent: null, expected: "unknown" },
  ];

  for (const { why, consent: given, expected } of cases) {
    it(`reports ${expected} for ${why}`, () => {
      assert.equal(consentState(given, NOW), expected);
    });
  }

  it("treats an expiry exactly at now as expired, not active", () => {
    assert.equal(consentState(consent({ expiresAt: NOW }), NOW), "expired");
  });
});

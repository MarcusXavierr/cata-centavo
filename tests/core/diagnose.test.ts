import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { diagnose } from "../../src/core/diagnose.ts";
import type { BankFailure } from "../../src/core/contracts.ts";
import { AuthError } from "../../src/pluggy/errors.ts";
import { connection, fakeBank } from "../fakes/fake-bank.ts";
import { fixedClock } from "../fakes/fixed-clock.ts";

const NOW = new Date("2026-07-25T12:00:00.000Z");

function toFailure(error: unknown): BankFailure {
  assert.ok(error instanceof Error);
  let kind: BankFailure["kind"];
  if (error instanceof AuthError) {
    kind = "auth";
  } else {
    kind = "unavailable";
  }
  return { kind, message: error.message };
}

describe("diagnose", () => {
  it("reports the connection when its consent lookup fails, with consent null and state unknown", async () => {
    const bank = fakeBank({
      connections: [connection("conn-1")],
      unreachableConsent: { "conn-1": new Error("consent endpoint is down") },
    });

    const [result] = await diagnose(bank, ["conn-1"], toFailure, fixedClock(NOW));

    assert.ok(result);
    assert.equal(result.id, "conn-1");
    assert.ok(result.connection !== null);
    assert.equal(result.failure, null);
    assert.equal(result.consent, null);
    assert.equal(result.state, "unknown");
  });

  it("reports the consent when the connection lookup fails, and still gives its own failure", async () => {
    const bank = fakeBank({
      connections: [connection("conn-1")],
      unreachable: { "conn-1": new AuthError("refused", 401) },
      consents: { "conn-1": { expiresAt: null, revokedAt: null, products: ["ACCOUNTS"] } },
    });

    const [result] = await diagnose(bank, ["conn-1"], toFailure, fixedClock(NOW));

    assert.ok(result);
    assert.equal(result.connection, null);
    assert.deepEqual(result.failure, { kind: "auth", message: "refused" });
    assert.deepEqual(result.consent, { expiresAt: null, revokedAt: null, products: ["ACCOUNTS"] });
    assert.equal(result.state, "active");
  });

  it("keeps output order the same as the input, regardless of which ids fail", async () => {
    const bank = fakeBank({
      connections: [connection("conn-1"), connection("conn-3")],
      unreachable: { "conn-2": new AuthError("refused", 401) },
    });

    const results = await diagnose(bank, ["conn-1", "conn-2", "conn-3"], toFailure, fixedClock(NOW));

    assert.deepEqual(results.map((result) => result.id), ["conn-1", "conn-2", "conn-3"]);
  });

  it("does not let one failed id abort the rest", async () => {
    const bank = fakeBank({
      connections: [connection("conn-1")],
      unreachable: { "conn-2": new AuthError("refused", 401) },
    });

    const results = await diagnose(bank, ["conn-1", "conn-2"], toFailure, fixedClock(NOW));

    assert.equal(results.length, 2);
    assert.equal(results[0]?.connection?.id, "conn-1");
    assert.deepEqual(results[1]?.failure, { kind: "auth", message: "refused" });
  });
});

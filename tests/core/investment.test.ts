import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { collectInvestments, compareInvestmentPositions, sortInvestments, summarizeInvestments } from "../../src/core/investments.ts";
import type { BankFailure } from "../../src/core/contracts.ts";
import { AuthError } from "../../src/pluggy/errors.ts";
import { fakeBank, investmentPosition, threeConnections, type FakeBankOptions } from "../fakes/fake-bank.ts";

function toFailure(error: unknown): BankFailure {
  assert.ok(error instanceof Error);
  if (error instanceof AuthError) {
    return { kind: "auth", message: error.message };
  }
  return { kind: "unavailable", message: error.message };
}

describe("collectInvestments", () => {
  const cases = [
    { why: "treats fulfilled empty as healthy", selected: ["conn-1"], investments: { "conn-1": [] }, expectPositions: [], expectUnavailable: [] },
    { why: "preserves survivor after rejection", selected: ["conn-1", "conn-2"], investments: { "conn-1": [investmentPosition("position-1", { connectionId: "conn-1" })] }, unreachable: { "conn-2": new AuthError("refused", 401) }, expectPositions: ["position-1"], expectUnavailable: [{ connectionId: "conn-2", kind: "auth" }] },
    { why: "reports all rejects", selected: ["conn-1", "conn-2"], unreachable: { "conn-1": new AuthError("first refused", 401), "conn-2": new Error("second unavailable") }, expectPositions: [], expectUnavailable: [{ connectionId: "conn-1", kind: "auth" }, { connectionId: "conn-2", kind: "unavailable" }] },
    { why: "returns empty arrays for zero selected", selected: [], expectPositions: [], expectUnavailable: [] },
  ] as const;

  for (const c of cases) {
    it(c.why, async () => {
      const fixture = threeConnections();
      let options: FakeBankOptions = { ...fixture };
      if ("investments" in c) {
        options = { ...options, investments: c.investments };
      }
      if ("unreachable" in c) {
        options = { ...options, unreachable: c.unreachable };
      }
      const result = await collectInvestments(fakeBank(options), c.selected, toFailure);
      assert.deepEqual(result.positions.map(({ id }) => id), c.expectPositions);
      assert.deepEqual(result.unavailable.map(({ connectionId, kind }) => ({ connectionId, kind })), c.expectUnavailable);
    });
  }
});

describe("investment ordering and summaries", () => {
  it("sorts by currency, balance descending, institution, name, then id", () => {
    const positions = [
      investmentPosition("id-z", { currency: "USD", balanceCents: 10_000, institution: "Bank" }),
      investmentPosition("id-b", { currency: "BRL", balanceCents: 20_000, institution: "Bank", name: "CDB" }),
      investmentPosition("id-a", { currency: "BRL", balanceCents: 20_000, institution: "Bank", name: "CDB" }),
      investmentPosition("id-c", { currency: "BRL", balanceCents: 20_000, institution: "Other", name: "A" }),
      investmentPosition("id-d", { currency: "BRL", balanceCents: 10_000, institution: "A", name: "Z" }),
      investmentPosition("id-y", { currency: "USD", balanceCents: 10_000, institution: "Bank", name: "A" }),
    ];
    const sorted = sortInvestments(positions);
    assert.deepEqual(sorted.map(({ id }) => id), ["id-a", "id-b", "id-c", "id-d", "id-y", "id-z"]);
    assert.equal(compareInvestmentPositions(sorted[0]!, sorted[1]!), -1);
    assert.equal(compareInvestmentPositions(sorted[0]!, sorted[2]!), -1);
    assert.equal(compareInvestmentPositions(sorted[4]!, sorted[5]!), -1);
    assert.equal(compareInvestmentPositions(sorted[1]!, sorted[0]!), 1);
    assert.equal(compareInvestmentPositions(sorted[0]!, sorted[0]!), 0);
  });

  it("keeps equal balances at the rest of the ordering tuple", () => {
    const position = investmentPosition("same", { balanceCents: 12_345 });
    assert.equal(compareInvestmentPositions(position, { ...position }), 0);
  });

  it("orders by name before id when the earlier name has the later id", () => {
    const earlierName = investmentPosition("z-id", { name: "Alpha" });
    const laterName = investmentPosition("a-id", { name: "Zulu" });
    assert.equal(compareInvestmentPositions(earlierName, laterName), -1);
    assert.equal(compareInvestmentPositions(laterName, earlierName), 1);
  });

  it("summarizes BRL and USD balances in ascending currency order", () => {
    const positions = [investmentPosition("usd", { currency: "USD", balanceCents: 5_000 }), investmentPosition("brl-a", { currency: "BRL", balanceCents: 12_345 }), investmentPosition("brl-b", { currency: "BRL", balanceCents: 6_000 })];
    assert.deepEqual(summarizeInvestments(positions), [{ currency: "BRL", balanceCents: 18_345 }, { currency: "USD", balanceCents: 5_000 }]);
  });

  it("uses the complete ordering tuple as a strict cursor boundary", () => {
    const prior = investmentPosition("position-1", { currency: "BRL", balanceCents: 12_345, institution: "Nubank", name: "CDB" });
    const next = investmentPosition("position-2", { currency: "BRL", balanceCents: 12_345, institution: "Nubank", name: "CDB" });
    assert.equal(compareInvestmentPositions(prior, next), -1);
    assert.ok(compareInvestmentPositions(next, prior) > 0);
  });
});

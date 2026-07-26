import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { TransactionFilter } from "../../src/core/contracts.ts";
import { decodeCursor, encodeCursor } from "../../src/mcp/cursor.ts";

const FILTER: TransactionFilter = {
  accountIds: ["acc-1"],
  from: "2026-06-01",
  to: "2026-06-30",
  minAmountCents: -100,
};

describe("transaction cursor", () => {
  it("round-trips a position", () => {
    const position = { localDate: "2026-06-15", id: "t-1" };
    const decoded = decodeCursor(encodeCursor(position, FILTER), FILTER);

    assert.equal(decoded.ok, true);
    if (decoded.ok) {
      assert.deepEqual(decoded.position, position);
    }
  });

  it("rejects a cursor issued for different filters", () => {
    const cursor = encodeCursor({ localDate: "2026-06-15", id: "t-1" }, FILTER);

    assert.equal(decodeCursor(cursor, { ...FILTER, categories: ["11000000"] }).ok, false);
  });

  it("accepts a cursor when only the page size changed", () => {
    const cursor = encodeCursor({ localDate: "2026-06-15", id: "t-1" }, { ...FILTER, limit: 10 });

    assert.equal(decodeCursor(cursor, { ...FILTER, limit: 50 }).ok, true);
  });

  it("is insensitive to key order in the filter", () => {
    const cursor = encodeCursor({ localDate: "2026-06-15", id: "t-1" }, { from: "a", to: "b", accountIds: [] });

    assert.equal(decodeCursor(cursor, { to: "b", accountIds: [], from: "a" }).ok, true);
  });

  const MALFORMED: readonly { readonly name: string; readonly cursor: string }[] = [
    { name: "empty", cursor: "" },
    { name: "not base64", cursor: "!!!" },
    { name: "base64 of not-JSON", cursor: Buffer.from("hello").toString("base64url") },
    { name: "JSON missing the position", cursor: Buffer.from('{"f":"x"}').toString("base64url") },
  ];

  for (const { name, cursor } of MALFORMED) {
    it(`refuses a malformed cursor rather than throwing: ${name}`, () => {
      assert.equal(decodeCursor(cursor, FILTER).ok, false);
    });
  }
});

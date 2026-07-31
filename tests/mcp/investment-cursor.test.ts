import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  InvestmentCursorFilter,
  InvestmentCursorPosition,
} from "../../src/mcp/investment-cursor.ts";
import { decodeCursor, encodeCursor } from "../../src/mcp/investment-cursor.ts";

const POSITION: InvestmentCursorPosition = {
  currency: "BRL",
  balanceCents: 12345,
  institution: "Nubank",
  name: "CDB",
  id: "position-1",
};

const NULL_FILTER: InvestmentCursorFilter = { connectionId: null };


describe("investment cursor", () => {
  it("round-trips the complete position with a null connection filter", () => {
    const decoded = decodeCursor(encodeCursor(POSITION, NULL_FILTER), NULL_FILTER);

    assert.deepEqual(decoded, { ok: true, position: POSITION });
  });

  it("rejects malformed base64url without throwing", () => {
    assert.deepEqual(decodeCursor("!!!", NULL_FILTER), {
      ok: false,
      message: "cursor is not valid base64url JSON",
    });
  });

  it("rejects base64url that does not contain JSON", () => {
    const cursor = Buffer.from("not-json", "utf8").toString("base64url");

    assert.deepEqual(decodeCursor(cursor, NULL_FILTER), {
      ok: false,
      message: "cursor is not valid base64url JSON",
    });
  });

  for (const [name, payload] of [
    ["missing currency", { b: 12345, t: "Nubank", n: "CDB", i: "position-1", f: "x" }],
    ["currency number", { c: 7, b: 12345, t: "Nubank", n: "CDB", i: "position-1", f: "x" }],
    ["missing balanceCents", { c: "BRL", t: "Nubank", n: "CDB", i: "position-1", f: "x" }],
    ["balanceCents string", { c: "BRL", b: "12345", t: "Nubank", n: "CDB", i: "position-1", f: "x" }],
    ["missing institution", { c: "BRL", b: 12345, n: "CDB", i: "position-1", f: "x" }],
    ["institution number", { c: "BRL", b: 12345, t: 7, n: "CDB", i: "position-1", f: "x" }],
    ["missing name", { c: "BRL", b: 12345, t: "Nubank", i: "position-1", f: "x" }],
    ["name number", { c: "BRL", b: 12345, t: "Nubank", n: 7, i: "position-1", f: "x" }],
    ["missing id", { c: "BRL", b: 12345, t: "Nubank", n: "CDB", f: "x" }],
    ["id number", { c: "BRL", b: 12345, t: "Nubank", n: "CDB", i: 7, f: "x" }],
    ["unsafe balanceCents", { c: "BRL", b: 2 ** 53, t: "Nubank", n: "CDB", i: "position-1", f: "x" }],
  ] as const) {
    it(`rejects ${name}`, () => {
      assert.deepEqual(
        decodeCursor(Buffer.from(JSON.stringify(payload), "utf8").toString("base64url"), NULL_FILTER),
        {
          ok: false,
          message: "cursor is not valid base64url JSON",
        },
      );
    });
  }

  it("rejects a cursor when connection ids differ", () => {
    const cursor = encodeCursor(POSITION, { connectionId: "conn-1" });

    assert.deepEqual(decodeCursor(cursor, { connectionId: "conn-2" }), {
      ok: false,
      message: "cursor does not match this filter",
    });
  });

  it("rejects a cursor when null and a connection id differ", () => {
    const cursor = encodeCursor(POSITION, { connectionId: null });

    assert.deepEqual(decodeCursor(cursor, { connectionId: "conn-1" }), {
      ok: false,
      message: "cursor does not match this filter",
    });
  });

  it("preserves balanceCents and id in the full position tuple", () => {
    const position = { ...POSITION, balanceCents: -987654321, id: "position-special" };
    const decoded = decodeCursor(encodeCursor(position, NULL_FILTER), NULL_FILTER);

    assert.equal(decoded.ok, true);
    if (decoded.ok) {
      assert.equal(decoded.position.balanceCents, position.balanceCents);
      assert.equal(decoded.position.id, position.id);
    }
  });

  it("ignores limit-like properties because only connectionId is fingerprinted", () => {
    const issuedFilter = { connectionId: "conn-1", limit: 10 } as unknown as InvestmentCursorFilter;
    const requestedFilter = { connectionId: "conn-1", limit: 100 } as unknown as InvestmentCursorFilter;
    const cursor = encodeCursor(POSITION, issuedFilter);

    assert.deepEqual(decodeCursor(cursor, requestedFilter), { ok: true, position: POSITION });
  });
});

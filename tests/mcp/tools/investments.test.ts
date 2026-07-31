import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ToolDeps } from "../../../src/mcp/tools/result.ts";
import { handleGetInvestments } from "../../../src/mcp/tools/investments.ts";
import { connection, investmentPosition } from "../../fakes/fake-bank.ts";
import { fakeLogger } from "../../fakes/fake-logger.ts";
import { fakeSource, type FakeSourceOptions } from "../../fakes/fake-source.ts";

function depsWith(options: {
  readonly connections?: readonly ReturnType<typeof connection>[];
  readonly investments?: Readonly<Record<string, readonly ReturnType<typeof investmentPosition>[]>>;
  readonly unreachable?: Readonly<Record<string, Error>>;
} = {}): ToolDeps & { readonly bankCalls: readonly string[] } {
  let sourceOptions: FakeSourceOptions = {
    connections: options.connections ?? [connection("conn-1")],
  };
  if (options.investments !== undefined) {
    sourceOptions = { ...sourceOptions, investments: options.investments };
  }
  if (options.unreachable !== undefined) {
    sourceOptions = { ...sourceOptions, unreachable: options.unreachable };
  }
  const source = fakeSource(sourceOptions);
  const log = fakeLogger();
  return {
    source,
    log,
    reader: source.reader,
    writer: source.writer,
    clock: { now: () => new Date("2026-07-30T12:00:00.000Z") },
    bankCalls: source.bank.calls,
  };
}

function textOf(result: { readonly content: readonly { readonly type: string; readonly text?: string }[] }): string {
  const first = result.content[0];
  assert.ok(first !== undefined);
  assert.equal(first.type, "text");
  assert.ok(first.text !== undefined);
  return first.text;
}

function currencyFor(index: number): string {
  if (index % 2 === 0) {
    return "BRL";
  }
  return "USD";
}

function institutionFor(index: number): string {
  if (index % 3 === 0) {
    return "Itaú";
  }
  return "Nubank";
}

function positions(count: number): readonly ReturnType<typeof investmentPosition>[] {
  return Array.from({ length: count }, (_, index) => investmentPosition(`investment-${index.toString().padStart(3, "0")}`, {
    balanceCents: (count - index) * 100,
    currency: currencyFor(index),
    institution: institutionFor(index),
    name: `Position ${index.toString().padStart(3, "0")}`,
  }));
}

describe("getInvestments", () => {
  it("returns 100 sorted rows, currency totals, and a continuation cursor", async () => {
    const deps = depsWith({ investments: { "conn-1": positions(101) } });

    const result = await handleGetInvestments(deps, { limit: 100 });
    const payload = JSON.parse(textOf(result));

    assert.equal(result.isError, undefined);
    assert.equal(payload.positions.length, 100);
    assert.deepEqual(payload.positions.map((row: { readonly id: string }) => row.id), [...positions(101)].sort((left, right) => {
      if (left.currency !== right.currency) return left.currency.localeCompare(right.currency);
      if (left.balanceCents !== right.balanceCents) return right.balanceCents - left.balanceCents;
      if (left.institution !== right.institution) return left.institution.localeCompare(right.institution);
      if (left.name !== right.name) return left.name.localeCompare(right.name);
      return left.id.localeCompare(right.id);
    }).slice(0, 100).map((row) => row.id));
    assert.deepEqual(payload.totals, [
      { currency: "BRL", balance: "2601.00" },
      { currency: "USD", balance: "2550.00" },
    ]);
    assert.equal(payload.totalPositions, 101);
    assert.equal(payload.hasMore, true);
    assert.equal(typeof payload.nextCursor, "string");
  });

  it("continues after a cursor without duplicates and clears the final cursor", async () => {
    const deps = depsWith({ investments: { "conn-1": positions(101) } });
    const first = await handleGetInvestments(deps, { limit: 100 });
    const firstPayload = JSON.parse(textOf(first));

    const second = await handleGetInvestments(deps, { limit: 100, cursor: firstPayload.nextCursor });
    const secondPayload = JSON.parse(textOf(second));

    assert.equal(secondPayload.positions.length, 1);
    assert.equal(new Set([...firstPayload.positions, ...secondPayload.positions].map((row) => row.id)).size, 101);
    assert.equal(secondPayload.hasMore, false);
    assert.equal(secondPayload.nextCursor, null);
  });

  it("filters to a configured connection and rejects an unconfigured connection before the bank call", async () => {
    const deps = depsWith({
      connections: [connection("conn-1"), connection("conn-2")],
      investments: {
        "conn-1": [investmentPosition("one", { connectionId: "conn-1", balanceCents: 100 })],
        "conn-2": [investmentPosition("two", { connectionId: "conn-2", balanceCents: 900, currency: "USD" })],
      },
    });

    const filtered = await handleGetInvestments(deps, { connectionId: "conn-2" });
    const filteredPayload = JSON.parse(textOf(filtered));
    assert.equal(filteredPayload.totalPositions, 1);
    assert.deepEqual(filteredPayload.totals, [{ currency: "USD", balance: "9.00" }]);

    const callsBefore = deps.bankCalls.length;
    const invalid = await handleGetInvestments(deps, { connectionId: "missing" });
    assert.equal(invalid.isError, true);
    assert.match(textOf(invalid), /connectionId.*configured|configured.*connectionId/iu);
    assert.equal(deps.bankCalls.length, callsBefore);
  });

  it("keeps available positions and reports one unavailable connection", async () => {
    const deps = depsWith({
      connections: [connection("conn-1"), connection("conn-2")],
      investments: { "conn-1": [investmentPosition("one", { balanceCents: 100 })] },
      unreachable: { "conn-2": new Error("temporary outage") },
    });

    const result = await handleGetInvestments(deps, {});
    const payload = JSON.parse(textOf(result));

    assert.equal(result.isError, undefined);
    assert.equal(payload.totalPositions, 1);
    assert.equal(payload.unavailable.length, 1);
    assert.equal(payload.unavailable[0].connectionId, "conn-2");
  });

  it("returns an error instead of zero totals when every selected connection fails", async () => {
    const deps = depsWith({
      connections: [connection("conn-1"), connection("conn-2")],
      unreachable: { "conn-1": new Error("outage one"), "conn-2": new Error("outage two") },
    });

    const result = await handleGetInvestments(deps, {});

    assert.equal(result.isError, true);
    assert.match(textOf(result), /unavailable|failed/iu);
  });

  it("succeeds with empty totals when no connections are configured", async () => {
    const result = await handleGetInvestments(depsWith({ connections: [] }), {});
    const payload = JSON.parse(textOf(result));

    assert.equal(result.isError, undefined);
    assert.deepEqual(payload.positions, []);
    assert.deepEqual(payload.totals, []);
    assert.equal(payload.totalPositions, 0);
    assert.equal(payload.hasMore, false);
    assert.equal(payload.nextCursor, null);
  });

  it("formats balances as decimal strings and omits null quantities", async () => {
    const deps = depsWith({
      investments: {
        "conn-1": [
          investmentPosition("with-quantity", { balanceCents: -8990, quantity: "2.5" }),
          investmentPosition("without-quantity", { balanceCents: 12345, quantity: null }),
        ],
      },
    });

    const result = await handleGetInvestments(deps, {});
    const payload = JSON.parse(textOf(result));
    const withQuantity = payload.positions.find((row: { readonly id: string }) => row.id === "with-quantity");
    const withoutQuantity = payload.positions.find((row: { readonly id: string }) => row.id === "without-quantity");

    assert.equal(withQuantity.balance, "-89.90");
    assert.equal(withQuantity.quantity, "2.5");
    assert.equal(Object.hasOwn(withoutQuantity, "quantity"), false);
  });

  it("rejects malformed cursors and unreadable limits", async () => {
    const deps = depsWith({ investments: { "conn-1": [investmentPosition("one")] } });

    const malformed = await handleGetInvestments(deps, { cursor: "not-a-cursor" });
    assert.equal(malformed.isError, true);
    assert.match(textOf(malformed), /cursor/iu);

    const outOfRange = await handleGetInvestments(deps, { limit: 101 });
    assert.equal(outOfRange.isError, true);
    assert.match(textOf(outOfRange), /limit/iu);

    const nonInteger = await handleGetInvestments(deps, { limit: 1.5 });
    assert.equal(nonInteger.isError, true);
    assert.match(textOf(nonInteger), /limit/iu);
  });
});

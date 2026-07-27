import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Clock, TransactionFilter, TransactionStore } from "../../../src/core/contracts.ts";
import type { TransactionReader } from "../../../src/core/transactions.ts";
import { CATEGORIES } from "../../../src/core/category.ts";
import { handleGetTransactions, handleListTransactions } from "../../../src/mcp/tools/transactions.ts";

import type { ToolDeps } from "../../../src/mcp/tools/result.ts";
import { fakeLogger } from "../../fakes/fake-logger.ts";
import { fakeSource } from "../../fakes/fake-source.ts";
import { account } from "../../fakes/fake-bank.ts";
import { derived, tx } from "../../fakes/transaction-builder.ts";

const RANGE = { startDate: "2026-06-01", endDate: "2026-06-30" };

type StoreFixture = {
  readonly store: TransactionStore;
  readonly filters: TransactionFilter[];
};

type DependencyOptions = {
  readonly rows?: readonly ReturnType<typeof tx>[];
  readonly accounts?: readonly ReturnType<typeof account>[];
  readonly unavailable?: readonly { readonly connectionId: string; readonly kind: "auth"; readonly message: string }[];
  readonly categoriesDown?: boolean;
  readonly clock?: Clock;
};

function recordingStore(rows: readonly ReturnType<typeof tx>[] = []): StoreFixture {
  const filters: TransactionFilter[] = [];
  const store: TransactionStore = {
    syncedLastUpdatedAt: () => undefined,
    replaceAccount: () => 0,
    query: (filter) => {
      filters.push(filter);
      let selected = [...rows].sort(compareRows);
      const after = filter.after;
      if (after !== undefined) {
        selected = selected.filter((row) => comesAfter(row, after));
      }
      if (filter.limit !== undefined) {
        selected = selected.slice(0, filter.limit);
      }
      return selected.map((row) => derived(row));
    },
    byIds: () => [],
    dataThrough: (accountIds) => new Map(accountIds.map((accountId) => [connectionFor(accountId), "2026-06-30"])),
  };
  return { store, filters };
}


function compareRows(left: ReturnType<typeof tx>, right: ReturnType<typeof tx>): number {
  const dateOrder = right.localDate.localeCompare(left.localDate);
  if (dateOrder !== 0) {
    return dateOrder;
  }
  return right.id.localeCompare(left.id);
}

function comesAfter(row: ReturnType<typeof tx>, after: NonNullable<TransactionFilter["after"]>): boolean {
  if (row.localDate < after.localDate) {
    return true;
  }
  if (row.localDate > after.localDate) {
    return false;
  }
  return row.id < after.id;
}

function connectionFor(accountId: string): string {
  if (accountId === "acc-1") {
    return "conn-1";
  }
  return "conn-2";
}

function depsWith(options: DependencyOptions = {}): ToolDeps & { readonly filters: readonly TransactionFilter[] } {
  const source = fakeSource({
    connections: [{
      id: "conn-1",
      institution: "Nubank",
      status: "UPDATED",
      executionStatus: "SUCCESS",
      lastUpdatedAt: new Date("2026-07-25T09:00:00.000Z"),
      parameter: null,
      warnings: [],
    }],
    accounts: { "conn-1": options.accounts ?? [account("acc-1")] },
  });
  const fixture = recordingStore(options.rows);
  const accounts = options.accounts ?? [account("acc-1")];
  const loadResult = {
    accounts,
    unavailable: options.unavailable ?? [],
  };
  const reader: TransactionReader = {
    load: async () => loadResult,
    query: (filter) => fixture.store.query(filter),
    byIds: (ids) => fixture.store.byIds(ids),
    dataThrough: (accountIds, today) => fixture.store.dataThrough(accountIds, today),
  };
  const clock = options.clock ?? { now: () => new Date("2026-07-01T12:00:00.000Z") };
  return { source, reader, writer: source.writer, clock, log: fakeLogger(), filters: fixture.filters };
}



function textOf(result: { readonly content: readonly { readonly type: string; readonly text?: string }[] }): string {
  const first = result.content[0];
  assert.ok(first !== undefined);
  assert.equal(first.type, "text");
  assert.ok(first.text !== undefined);
  return first.text;
}

function lastFilterOf(deps: { readonly filters: readonly TransactionFilter[] }): TransactionFilter | undefined {
  return deps.filters.at(-1);
}

describe("getTransactions", () => {
  const PARAMETER_CASES: readonly {
    readonly name: string;
    readonly input: Record<string, unknown>;
    readonly expected: Partial<TransactionFilter>;
  }[] = [
    { name: "startDate", input: RANGE, expected: { from: "2026-06-01" } },
    { name: "endDate", input: RANGE, expected: { to: "2026-06-30" } },
    { name: "categories", input: { ...RANGE, categories: ["11000000"] }, expected: { categories: ["11000000"] } },
    { name: "the uncategorized filter", input: { ...RANGE, categories: ["none"] }, expected: { categories: ["none"] } },
    { name: "a category mixed with none", input: { ...RANGE, categories: ["11000000", "none"] }, expected: { categories: ["11000000", "none"] } },
    { name: "minAmountCents", input: { ...RANGE, minAmountCents: -5_000 }, expected: { minAmountCents: -5_000 } },
    { name: "maxAmountCents", input: { ...RANGE, maxAmountCents: -100 }, expected: { maxAmountCents: -100 } },
    { name: "accountType", input: { ...RANGE, accountType: "CREDIT" }, expected: { accountType: "CREDIT" } },
    { name: "accountSubtype", input: { ...RANGE, accountSubtype: "CREDIT_CARD" }, expected: { accountSubtype: "CREDIT_CARD" } },
  ];

  for (const { name, input, expected } of PARAMETER_CASES) {
    it(`passes ${name} through to the query`, async () => {
      const deps = depsWith();
      await handleGetTransactions(deps, input);

      const filter = lastFilterOf(deps);
      assert.ok(filter);
      for (const [key, value] of Object.entries(expected)) {
        assert.deepEqual(filter[key as keyof TransactionFilter], value, key);
      }
    });
  }

  it("rejects an invented category at the boundary", async () => {
    const result = await handleGetTransactions(depsWith(), { ...RANGE, categories: ["alimentacao"] });

    assert.equal(result.isError, true);
  });

  it("rejects a leaf category, which is not a filter vocabulary", async () => {
    const result = await handleGetTransactions(depsWith(), { ...RANGE, categories: ["11010000"] });

    assert.equal(result.isError, true);
  });

  it("rejects an end date before the start date", async () => {
    const result = await handleGetTransactions(depsWith(), { startDate: "2026-06-30", endDate: "2026-06-01" });

    assert.equal(result.isError, true);
  });

  const REFUSAL_CASES: readonly { readonly name: string; readonly deps: () => ToolDeps; readonly matches: RegExp }[] = [
    {
      name: "an unavailable connection",
      deps: () => depsWith({ unavailable: [{ connectionId: "conn-2", kind: "auth", message: "revoked" }] }),
      matches: /conn-2/u,
    },
    {
      name: "mixed account currencies",
      deps: () => depsWith({ accounts: [account("acc-1"), account("acc-usd", { currency: "USD" })] }),
      matches: /USD/u,
    },
  ];



  for (const { name, deps, matches } of REFUSAL_CASES) {
    it(`refuses rather than returning a partial total: ${name}`, async () => {
      const result = await handleGetTransactions(deps(), RANGE);

      assert.equal(result.isError, true);
      assert.match(textOf(result), matches);
      assert.doesNotMatch(textOf(result), /"spent"/u);
    });
  }

  it("reads an empty period as empty rather than as a failure", async () => {
    const result = await handleGetTransactions(depsWith(), RANGE);

    assert.notEqual(result.isError, true);
    assert.equal(JSON.parse(textOf(result)).spent, "0.00");
  });

  it("keeps a zero total through serialization", async () => {
    const result = await handleGetTransactions(depsWith({ rows: [tx({ amountCents: 0 })] }), RANGE);

    assert.match(textOf(result), /"spent":"0\.00"/u);
  });

  it("does not trip the currency guard on a foreign purchase", async () => {
    const result = await handleGetTransactions(depsWith({
      rows: [tx({ originalAmountCents: -2_000, originalCurrency: "USD" })],
    }), RANGE);

    assert.notEqual(result.isError, true);
  });

  it("labels groups from our own category list, not the fetched strings", async () => {
    const result = await handleGetTransactions(depsWith({ rows: [tx({ categoryId: "05020000", amountCents: -100 })] }), RANGE);

    assert.equal(JSON.parse(textOf(result)).groups[0].label, CATEGORIES.transfers.pt);
  });

  it("derives today from the injected clock, in Sao Paulo", async () => {
    const result = await handleGetTransactions(depsWith({
      rows: [tx({ localDate: "2026-06-30", amountCents: -100 })],
      clock: { now: () => new Date("2026-07-01T01:00:00.000Z") },
    }), RANGE);

    assert.equal(JSON.parse(textOf(result)).upcoming, undefined);
  });
});

describe("listTransactions", () => {
  const CAP_CASES: readonly { readonly name: string; readonly limit: unknown; readonly ok: boolean }[] = [
    { name: "one row", limit: 1, ok: true },
    { name: "the cap itself", limit: 100, ok: true },
    { name: "one over the cap", limit: 101, ok: false },
    { name: "wildly over the cap", limit: 500, ok: false },
    { name: "zero", limit: 0, ok: false },
    { name: "negative", limit: -1, ok: false },
    { name: "fractional", limit: 1.5, ok: false },
  ];

  for (const { name, limit, ok } of CAP_CASES) {
    it(`enforces the row limit: ${name}`, async () => {
      const result = await handleListTransactions(depsWith({ rows: [tx()] }), { ...RANGE, limit });

      assert.equal(result.isError !== true, ok);
    });
  }

  it("pages forward without repeating or skipping a row", async () => {
    const deps = depsWith({ rows: storeWith(150) });
    const first = await handleListTransactions(deps, { ...RANGE, limit: 100 });
    const firstPayload = JSON.parse(textOf(first));
    const second = await handleListTransactions(deps, { ...RANGE, limit: 100, cursor: firstPayload.cursor });
    const secondPayload = JSON.parse(textOf(second));

    assert.equal(new Set([...idsOf(firstPayload), ...idsOf(secondPayload)]).size, 150);
  });

  it("offers no cursor on the last page", async () => {
    const result = await handleListTransactions(depsWith({ rows: storeWith(10) }), { ...RANGE, limit: 100 });

    assert.equal(JSON.parse(textOf(result)).cursor, undefined);
  });

  it("refuses a cursor issued for different filters", async () => {
    const deps = depsWith({ rows: storeWith(150) });
    const first = await handleListTransactions(deps, { ...RANGE, limit: 100 });
    const { cursor } = JSON.parse(textOf(first));

    const result = await handleListTransactions(deps, {
      startDate: "2026-01-01", endDate: "2026-12-31", limit: 100, cursor,
    });

    assert.equal(result.isError, true);
  });

  it("degrades with a notice instead of refusing when a connection is unavailable", async () => {
    const result = await handleListTransactions(depsWith({
      rows: [tx()],
      accounts: [account("acc-1")],
      unavailable: [{ connectionId: "conn-2", kind: "auth", message: "revoked" }],
    }), { ...RANGE, limit: 10 });

    assert.notEqual(result.isError, true);
    assert.match(textOf(result), /conn-2/u);
  });

  it("returns money as a decimal string", async () => {
    const result = await handleListTransactions(depsWith({ rows: [tx({ amountCents: -8_990 })] }), { ...RANGE, limit: 10 });

    assert.equal(JSON.parse(textOf(result)).transactions[0].amount, "-89.90");
  });
});

function storeWith(count: number): readonly ReturnType<typeof tx>[] {
  return Array.from({ length: count }, (_, index) => tx({ id: `t-${index.toString().padStart(3, "0")}`, amountCents: -(index + 1) * 100 }));
}

function idsOf(payload: { readonly transactions: readonly { readonly id: string }[] }): readonly string[] {
  return payload.transactions.map(({ id }) => id);
}

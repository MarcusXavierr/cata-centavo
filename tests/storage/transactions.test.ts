import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Logger, TransactionFilter } from "../../src/core/contracts.ts";

import { openDatabase } from "../../src/storage/db.ts";
import { CACHE_MIGRATIONS } from "../../src/storage/migrations.ts";
import { createTransactionStore } from "../../src/storage/transactions.ts";
import { fakeLogger } from "../fakes/fake-logger.ts";
import { tx } from "../fakes/transaction-builder.ts";

/** Seven rows chosen so each filter selects a disjoint, named subset. */
const SEED = [
  tx({ id: "jun-1", accountId: "acc-bank", localDate: "2026-06-01", amountCents: -1_000, categoryId: "05020000" }),
  tx({ id: "jun-30", accountId: "acc-bank", localDate: "2026-06-30", amountCents: -2_000, categoryId: "05020000" }),
  tx({ id: "may", accountId: "acc-bank", localDate: "2026-05-31", amountCents: -3_000, categoryId: "05020000" }),
  tx({ id: "jul", accountId: "acc-bank", localDate: "2026-07-01", amountCents: -4_000, categoryId: "05020000" }),
  tx({ id: "food", accountId: "acc-bank", localDate: "2026-05-10", amountCents: -6_000, categoryId: "11000000" }),
  tx({ id: "income", accountId: "acc-bank", localDate: "2026-05-11", amountCents: 9_000, categoryId: "01000000" }),
  tx({ id: "card", accountId: "acc-card", localDate: "2026-05-12", amountCents: -8_000, categoryId: "09000000", accountType: "CREDIT", accountSubtype: "CREDIT_CARD" }),
];

const WIDE_FILTER: TransactionFilter = { accountIds: ["acc-bank", "acc-card"], from: "2000-01-01", to: "2100-01-01" };

function storeAndDbFor(log: Logger = fakeLogger()) {
  const db = openDatabase({ path: ":memory:", migrations: CACHE_MIGRATIONS, policy: "rebuild" });
  return { store: createTransactionStore(db, log), db };
}

function storeFor(log: Logger = fakeLogger()) {
  return storeAndDbFor(log).store;
}


function seededStore() {
  const store = storeFor();
  store.replaceAccount("acc-bank", "conn-1", SEED.filter((row) => row.accountId === "acc-bank"), null);
  store.replaceAccount("acc-card", "conn-1", SEED.filter((row) => row.accountId === "acc-card"), null);
  return store;
}

function filterFor(accountIds: readonly string[]): TransactionFilter {
  return { ...WIDE_FILTER, accountIds };
}

function idsOf(rows: readonly { readonly id: string }[]): readonly string[] {
  return rows.map((row) => row.id);
}

describe("replaceAccount", () => {
  it("deletes rows the walk no longer reports", () => {
    const store = storeFor();
    store.replaceAccount("acc-1", "conn-1", [tx({ id: "a" }), tx({ id: "b" })], "2026-07-26T12:00:00.000Z");

    const deleted = store.replaceAccount("acc-1", "conn-1", [tx({ id: "a" })], "2026-07-27T12:00:00.000Z");

    assert.equal(deleted, 1);
    assert.deepEqual(idsOf(store.query(filterFor(["acc-1"]))), ["a"]);
  });

  it("reports zero deleted rows when a walk converges without removals", () => {
    const store = storeFor();

    assert.equal(store.replaceAccount("acc-1", "conn-1", [tx({ id: "a" })], null), 0);
  });

  it("does not touch another account's rows", () => {
    const store = storeFor();
    store.replaceAccount("acc-1", "conn-1", [tx({ id: "a", accountId: "acc-1" })], null);
    store.replaceAccount("acc-2", "conn-1", [tx({ id: "b", accountId: "acc-2" })], null);

    store.replaceAccount("acc-1", "conn-1", [], null);

    assert.equal(store.query(filterFor(["acc-2"])).length, 1);
  });

  it("is idempotent", () => {
    const store = storeFor();
    const rows = [tx({ id: "a" }), tx({ id: "b" })];

    store.replaceAccount("acc-1", "conn-1", rows, null);
    store.replaceAccount("acc-1", "conn-1", rows, null);

    assert.equal(store.query(filterFor(["acc-1"])).length, 2);
  });

  it("updates a row whose amount changed between walks", () => {
    const store = storeFor();
    store.replaceAccount("acc-1", "conn-1", [tx({ id: "a", amountCents: -1_000 })], null);

    store.replaceAccount("acc-1", "conn-1", [tx({ id: "a", amountCents: -1_500 })], null);

    assert.equal(store.query(filterFor(["acc-1"]))[0]?.amountCents, -1_500);
  });

  it("rolls back and leaves the previous state when a row is rejected", () => {
    const store = storeFor();
    store.replaceAccount("acc-1", "conn-1", [tx({ id: "a" })], null);

    assert.throws(() => store.replaceAccount("acc-1", "conn-1", [tx({ id: "b", localDate: null as never })], null));
    assert.deepEqual(idsOf(store.query(filterFor(["acc-1"]))), ["a"]);

    store.replaceAccount("acc-1", "conn-1", [tx({ id: "c" })], null);
    assert.deepEqual(idsOf(store.query(filterFor(["acc-1"]))), ["c"]);
  });

  it("round-trips every field, including the detail columns", () => {
    const store = storeFor();
    const row = tx({ id: "a", mcc: "5814", billId: "bill-1", billForecastDate: "2026-09", instalmentNumber: 3, instalmentTotal: 12, document: "12345678900", counterpartyName: "MARIA", paymentMethod: "PIX", originalAmountCents: -2_000, originalCurrency: "USD", purchaseDate: "2026-04-20" });

    store.replaceAccount("acc-1", "conn-1", [row], null);

    assert.deepEqual(store.query(filterFor(["acc-1"]))[0], {
      ...row,
      category: "01000000",
      categorySrc: "pluggy",
    });
  });

  it("re-reads bill_forecast_date after an upsert of the same id", () => {
    const store = storeFor();
    store.replaceAccount("acc-1", "conn-1", [tx({ id: "t-1", billForecastDate: null })], null);
    store.replaceAccount("acc-1", "conn-1", [tx({ id: "t-1", billForecastDate: "2026-09" })], null);

    assert.equal(store.query(filterFor(["acc-1"]))[0]?.billForecastDate, "2026-09");
  });

});

describe("syncedLastUpdatedAt", () => {
  it("is undefined before the first walk", () => {
    assert.equal(storeFor().syncedLastUpdatedAt("acc-1"), undefined);
  });

  const FRESHNESS_CASES: readonly { readonly name: string; readonly stamp: string | null }[] = [
    { name: "a known update time round-trips", stamp: "2026-07-26T12:00:00.000Z" },
    { name: "an unknown update time is stored as null, not absent", stamp: null },
  ];

  for (const { name, stamp } of FRESHNESS_CASES) {
    it(name, () => {
      const store = storeFor();
      store.replaceAccount("acc-1", "conn-1", [], stamp);
      assert.equal(store.syncedLastUpdatedAt("acc-1"), stamp);
    });
  }
});

describe("query", () => {
  const QUERY_CASES: readonly { readonly name: string; readonly filter: Partial<TransactionFilter>; readonly ids: readonly string[] }[] = [
    { name: "bounds the range inclusively at both ends", filter: { from: "2026-06-01", to: "2026-06-30" }, ids: ["jun-30", "jun-1"] },
    { name: "filters by several categories", filter: { categories: ["11000000", "01000000"] }, ids: ["income", "food"] },

    { name: "filters by minimum signed amount", filter: { minAmountCents: -5_000 }, ids: ["jul", "jun-30", "jun-1", "may", "income"] },
    { name: "filters by maximum signed amount", filter: { maxAmountCents: -5_000 }, ids: ["card", "food"] },
    { name: "filters by account type", filter: { accountType: "CREDIT" }, ids: ["card"] },
    { name: "filters by account subtype", filter: { accountSubtype: "CREDIT_CARD" }, ids: ["card"] },
    { name: "filters by account id", filter: { accountIds: ["acc-card"] }, ids: ["card"] },
    { name: "combines filters with AND", filter: { accountType: "CREDIT", categories: ["11000000"] }, ids: [] },
  ];

  for (const { name, filter, ids } of QUERY_CASES) {
    it(name, () => {
      assert.deepEqual(idsOf(seededStore().query({ ...WIDE_FILTER, ...filter })), ids);
    });
  }

  it("returns no rows for an empty account filter", () => {
    assert.deepEqual(seededStore().query({ ...WIDE_FILTER, accountIds: [] }), []);
  });

  it("returns no rows for an explicitly empty category filter", () => {
    assert.deepEqual(seededStore().query({ ...WIDE_FILTER, categories: [] }), []);
  });

  it("orders by date descending and breaks ties on id descending", () => {
    const store = storeFor();
    store.replaceAccount("acc-1", "conn-1", [tx({ id: "b", localDate: "2026-06-01" }), tx({ id: "a", localDate: "2026-06-01" }), tx({ id: "c", localDate: "2026-06-02" })], null);

    assert.deepEqual(idsOf(store.query(filterFor(["acc-1"]))), ["c", "b", "a"]);
  });

  it("pages with a keyset without repeating or skipping a row", () => {
    const store = seededStore();
    const first = store.query({ ...WIDE_FILTER, limit: 3 });
    const last = first.at(-1);
    assert.ok(last);

    const second = store.query({ ...WIDE_FILTER, limit: 3, after: { localDate: last.localDate, id: last.id } });

    assert.equal(new Set([...idsOf(first), ...idsOf(second)]).size, 6);
  });
});


describe("byIds", () => {
  it("returns the requested rows and handles an empty request", () => {
    const store = seededStore();

    assert.deepEqual(idsOf(store.byIds(["food", "card"])), ["card", "food"]);
    assert.deepEqual(store.byIds([]), []);
  });
});

describe("dataThrough", () => {
  it("reports where the data stops, ignoring future instalments", () => {
    const store = storeFor();
    store.replaceAccount("acc-1", "conn-1", [tx({ id: "past", localDate: "2026-07-08" }), tx({ id: "future", localDate: "2026-10-01" })], null);

    assert.equal(store.dataThrough(["acc-1"], "2026-07-26").get("conn-1"), "2026-07-08");
  });

  it("omits a connection with no cached rows rather than reporting a false date", () => {
    assert.equal(storeFor().dataThrough(["acc-1"], "2026-07-26").size, 0);
  });

  it("returns no connections for an empty account list", () => {
    assert.equal(seededStore().dataThrough([], "2026-07-26").size, 0);
  });
});

describe("top_category_id write-time roll-up", () => {
  it("stores the top-level ancestor of the leaf Pluggy sent", () => {
    const { store, db } = storeAndDbFor();
    store.replaceAccount("acc-1", "conn-1", [tx({ id: "a", categoryId: "11010000" })], null);

    const row = db.prepare("SELECT top_category_id FROM transactions WHERE id = 'a'").get();
    assert.equal(row?.["top_category_id"], "11000000");
  });

  it("keeps the leaf and warns when the tree does not know it, instead of failing the walk", () => {
    const log = fakeLogger();
    const { store, db } = storeAndDbFor(log);

    store.replaceAccount("acc-1", "conn-1", [tx({ id: "a", categoryId: "77770000" })], null);

    const row = db.prepare("SELECT category_id, top_category_id FROM transactions WHERE id = 'a'").get();
    assert.equal(row?.["category_id"], "77770000");
    assert.equal(row?.["top_category_id"], null);
    assert.ok(log.lines.some((line) => line.level === "warn" && line.message.includes("category")));
  });

  it("stores no top-level category for an uncategorized row", () => {
    const { store, db } = storeAndDbFor();

    store.replaceAccount("acc-1", "conn-1", [tx({ id: "a", categoryId: null })], null);

    const row = db.prepare("SELECT category_id, top_category_id FROM transactions WHERE id = 'a'").get();
    assert.equal(row?.["category_id"], null);
    assert.equal(row?.["top_category_id"], null);
  });
});

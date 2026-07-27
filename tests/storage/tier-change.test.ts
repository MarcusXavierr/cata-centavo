import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { aggregate } from "../../src/core/aggregate.ts";
import type { TransactionFilter } from "../../src/core/contracts.ts";
import type { Transaction } from "../../src/core/transaction.ts";
import { openDatabases } from "../../src/storage/db.ts";
import { createTransactionStore } from "../../src/storage/transactions.ts";
import { fakeLogger } from "../fakes/fake-logger.ts";
import { tx } from "../fakes/transaction-builder.ts";

const TODAY = "2026-07-26";

const WIDE: TransactionFilter = { accountIds: ["acc-bank", "acc-card"], from: "2000-01-01", to: "2100-01-01" };

/**
 * A synthetic wallet shaped so each fallback has to carry something.
 *
 * The bank rows are the demanding ones. A card row has an MCC and survives on
 * `mcc.ts` alone, so a wallet of nothing but cards would pass this file while
 * proving nothing about the harvest.
 */
const ENRICHED: readonly Transaction[] = [
  tx({ id: "card-food", accountId: "acc-card", accountType: "CREDIT", accountSubtype: "CREDIT_CARD", localDate: "2026-06-02", amountCents: -4_500, categoryId: "11010000", mcc: "5814" }),
  tx({ id: "card-ride", accountId: "acc-card", accountType: "CREDIT", accountSubtype: "CREDIT_CARD", localDate: "2026-06-03", amountCents: -2_200, categoryId: "19010000", mcc: "4121" }),
  tx({ id: "market-1", accountId: "acc-bank", localDate: "2026-06-04", amountCents: -13_000, categoryId: "10000000", document: "12345678000190" }),
  tx({ id: "market-2", accountId: "acc-bank", localDate: "2026-06-05", amountCents: -8_700, categoryId: "10000000", document: "12345678000190" }),
  tx({ id: "market-3", accountId: "acc-bank", localDate: "2026-06-06", amountCents: -5_100, categoryId: "10000000", document: "12345678000190" }),
  tx({ id: "rent", accountId: "acc-bank", localDate: "2026-06-07", amountCents: -190_000, categoryId: "17000000", document: null, mcc: null }),
  tx({ id: "salary", accountId: "acc-bank", localDate: "2026-06-01", amountCents: 640_000, categoryId: "01010000", document: null, mcc: null }),
  tx({ id: "own-transfer", accountId: "acc-bank", localDate: "2026-06-08", amountCents: -50_000, categoryId: "04020000", document: null, mcc: null }),
];

/** The same wallet as the free tier will serve it: every category gone. */
const BARE: readonly Transaction[] = ENRICHED.map((row) => ({ ...row, categoryId: null }));

function setupStore() {
  const dir = mkdtempSync(join(tmpdir(), "cata-tier-test-"));
  const paths = { cacheDb: join(dir, "cache.db"), dataDb: join(dir, "data.db"), logFile: join(dir, "app.log") };
  const { db } = openDatabases(paths);
  const clock = { now: () => new Date("2026-07-26T12:00:00.000Z") };
  const store = createTransactionStore(db, fakeLogger(), clock);
  const cleanup = () => {
    try {
      db.close();
    } catch {}
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  };
  return { db, store, cleanup };
}

function walk(store: ReturnType<typeof createTransactionStore>, rows: readonly Transaction[], stamp: string): void {
  store.replaceAccount("acc-bank", "conn-1", rows.filter((row) => row.accountId === "acc-bank"), stamp);
  store.replaceAccount("acc-card", "conn-1", rows.filter((row) => row.accountId === "acc-card"), stamp);
}

/**
 * The reason Phase 3 exists, as an assertion.
 *
 * The same wallet is walked twice: once as Pluggy answers today, then again
 * with every category nulled, as though the plan had already dropped to free.
 * Every aggregate, every group total and every filtered query must return the
 * same numbers. What may legitimately change is `categorySrc`.
 *
 * It runs without waiting for the tier to actually change, which is the only
 * reason it is worth having — a test that needs the window to close first would
 * report the failure after the data it was protecting was already gone.
 */
describe("the tier change", () => {
  it("leaves every aggregate untouched", () => {
    const { store, cleanup } = setupStore();
    try {
      walk(store, ENRICHED, "1");
      const before = aggregate(store.query(WIDE), TODAY);

      walk(store, BARE, "2");
      const after = aggregate(store.query(WIDE), TODAY);

      assert.deepEqual(after.groups, before.groups);
      assert.equal(after.spentCents, before.spentCents);
      assert.equal(after.receivedCents, before.receivedCents);
      assert.deepEqual(after.upcoming, before.upcoming);
    } finally {
      cleanup();
    }
  });

  const FILTERS = ["10000000", "11000000", "17000000", "01000000", "19000000", "04000000"] as const;

  it("leaves every filtered query untouched", () => {
    const { store, cleanup } = setupStore();
    try {
      walk(store, ENRICHED, "1");
      const before = FILTERS.map((category) => store.query({ ...WIDE, categories: [category] }).map((row) => row.id));

      walk(store, BARE, "2");
      const after = FILTERS.map((category) => store.query({ ...WIDE, categories: [category] }).map((row) => row.id));

      assert.deepEqual(after, before);
      assert.ok(before.some((ids) => ids.length > 0), "the filters matched nothing even before the tier change");
    } finally {
      cleanup();
    }
  });

  it("keeps nothing uncategorized that was categorized before", () => {
    const { store, cleanup } = setupStore();
    try {
      walk(store, ENRICHED, "1");
      walk(store, BARE, "2");

      const uncategorized = store.query({ ...WIDE, categories: ["none"] }).map((row) => row.id);

      assert.deepEqual(uncategorized, []);
    } finally {
      cleanup();
    }
  });

  it("categorizes a merchant's first transaction after the window closes", () => {
    const { store, cleanup } = setupStore();
    try {
      walk(store, ENRICHED, "1");
      walk(store, [...BARE, tx({ id: "market-4", accountId: "acc-bank", localDate: "2026-07-20", amountCents: -9_900, categoryId: null, document: "12345678000190" })], "2");

      const row = store.query(WIDE).find((candidate) => candidate.id === "market-4");

      assert.equal(row?.category, "10000000");
      assert.equal(row?.categorySrc, "learned");
    } finally {
      cleanup();
    }
  });

  it("invents no category for a merchant it was never taught", () => {
    const { store, cleanup } = setupStore();
    try {
      walk(store, ENRICHED, "1");
      walk(store, [...BARE, tx({ id: "stranger", accountId: "acc-bank", localDate: "2026-07-21", amountCents: -1_000, categoryId: null, document: "99999999000199" })], "2");

      const row = store.query(WIDE).find((candidate) => candidate.id === "stranger");

      assert.equal(row?.category, null);
      assert.equal(row?.categorySrc, null);
    } finally {
      cleanup();
    }
  });
});

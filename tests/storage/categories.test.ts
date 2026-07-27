import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { TransactionFilter } from "../../src/core/contracts.ts";
import { openDatabases } from "../../src/storage/db.ts";
import { createCategoryWriter } from "../../src/storage/categories.ts";
import { createTransactionStore } from "../../src/storage/transactions.ts";

import { fakeLogger } from "../fakes/fake-logger.ts";
import { tx } from "../fakes/transaction-builder.ts";

const WIDE: TransactionFilter = {
  accountIds: ["acc-bank", "acc-card"],
  from: "2000-01-01",
  to: "2100-01-01",
};

function setupStore() {
  const dir = mkdtempSync(join(tmpdir(), "cata-cat-test-"));
  const paths = { cacheDb: join(dir, "cache.db"), dataDb: join(dir, "data.db"), logFile: join(dir, "app.log") };
  const { db } = openDatabases(paths);

  const store = createTransactionStore(db, fakeLogger());
  const cleanup = () => {
    try {
      db.close();
    } catch {}
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  };
  return { db, store, paths, cleanup };
}

describe("category derivation", () => {
  it("resolves each branch in isolation", () => {
    const { db, store, cleanup } = setupStore();
    try {
      // 1. override
      db.prepare("INSERT INTO userdata.category_overrides (transaction_id, category, created_at) VALUES ('tx-1', '01000000', '2026-07-26')").run();
      // 2. counterparty (manual)
      db.prepare("INSERT INTO userdata.counterparty_categories (document, category, origin, created_at) VALUES ('11111111000111', '02000000', 'manual', '2026-07-26')").run();
      // 4. snapshot
      db.prepare("INSERT INTO userdata.category_snapshot (transaction_id, category_id, top_category_id, harvested_at) VALUES ('tx-4', '04010000', '04000000', '2026-07-26')").run();
      // 5. learned
      db.prepare("INSERT INTO userdata.counterparty_categories (document, category, origin, created_at) VALUES ('22222222000122', '05000000', 'learned', '2026-07-26')").run();


      const rows = [
        tx({ id: "tx-1", accountId: "acc-bank", categoryId: null }),
        tx({ id: "tx-2", accountId: "acc-bank", categoryId: null, document: "11111111000111" }),
        tx({ id: "tx-3", accountId: "acc-bank", categoryId: "03010000" }), // pluggy top_category_id = 03000000
        tx({ id: "tx-4", accountId: "acc-bank", categoryId: null }),
        tx({ id: "tx-5", accountId: "acc-bank", categoryId: null, document: "22222222000122" }),
        tx({ id: "tx-6", accountId: "acc-bank", categoryId: null, mcc: "780" }), // mcc 780 maps to 05000000 in seed
      ];

      store.replaceAccount("acc-bank", "conn-1", rows, null);

      const results = store.byIds(["tx-1", "tx-2", "tx-3", "tx-4", "tx-5", "tx-6"]);
      const byId = new Map(results.map((r) => [r.id, r]));

      assert.deepEqual(byId.get("tx-1")?.category, "01000000");
      assert.deepEqual(byId.get("tx-1")?.categorySrc, "override");

      assert.deepEqual(byId.get("tx-2")?.category, "02000000");
      assert.deepEqual(byId.get("tx-2")?.categorySrc, "counterparty");

      assert.deepEqual(byId.get("tx-3")?.category, "03000000");
      assert.deepEqual(byId.get("tx-3")?.categorySrc, "pluggy");

      assert.deepEqual(byId.get("tx-4")?.category, "04000000");
      assert.deepEqual(byId.get("tx-4")?.categorySrc, "pluggy"); // snapshot reports pluggy

      assert.deepEqual(byId.get("tx-5")?.category, "05000000");
      assert.deepEqual(byId.get("tx-5")?.categorySrc, "learned");

      assert.deepEqual(byId.get("tx-6")?.category, "05000000");
      assert.deepEqual(byId.get("tx-6")?.categorySrc, "mcc");
    } finally {
      cleanup();
    }
  });

  it("prefers the override to everything else", () => {
    const { db, store, cleanup } = setupStore();
    try {
      db.prepare("INSERT INTO userdata.category_overrides (transaction_id, category, created_at) VALUES ('tx-all', '01000000', '2026-07-26')").run();
      db.prepare("INSERT INTO userdata.counterparty_categories (document, category, origin, created_at) VALUES ('99999999000199', '02000000', 'manual', '2026-07-26')").run();
      db.prepare("INSERT INTO userdata.category_snapshot (transaction_id, category_id, top_category_id, harvested_at) VALUES ('tx-all', '04010000', '04000000', '2026-07-26')").run();

      const row = tx({ id: "tx-all", accountId: "acc-bank", categoryId: "03010000", document: "99999999000199", mcc: "780" });
      store.replaceAccount("acc-bank", "conn-1", [row], null);

      const [res] = store.byIds(["tx-all"]);
      assert.deepEqual(res?.category, "01000000");
      assert.deepEqual(res?.categorySrc, "override");
    } finally {
      cleanup();
    }
  });

  it("keeps an override after cache.db is rebuilt", () => {
    const { db, paths, cleanup } = setupStore();
    try {
      db.prepare("INSERT INTO userdata.category_overrides (transaction_id, category, created_at) VALUES ('tx-persist', '01000000', '2026-07-26')").run();
      let store = createTransactionStore(db, fakeLogger());
      store.replaceAccount("acc-bank", "conn-1", [tx({ id: "tx-persist", accountId: "acc-bank", categoryId: "11010000" })], null);

      // Force rebuild on cache.db by dropping main schema / setting version = 0
      db.exec("PRAGMA main.user_version = 0");
      // Re-open databases
      db.close();
      const reopened = openDatabases(paths);
      store = createTransactionStore(reopened.db, fakeLogger());
      store.replaceAccount("acc-bank", "conn-1", [tx({ id: "tx-persist", accountId: "acc-bank", categoryId: "11010000" })], null);

      const [res] = store.byIds(["tx-persist"]);
      assert.deepEqual(res?.category, "01000000");
      assert.deepEqual(res?.categorySrc, "override");
      reopened.db.close();
    } finally {
      cleanup();
    }
  });

  it("filters by a top-level id and returns rows tagged with its children", () => {
    const { store, cleanup } = setupStore();
    try {
      store.replaceAccount("acc-bank", "conn-1", [tx({ id: "child", accountId: "acc-bank", categoryId: "11010000" })], null);
      const res = store.query({ ...WIDE, categories: ["11000000"] });
      assert.equal(res.length, 1);
      assert.equal(res[0]?.id, "child");
      assert.equal(res[0]?.category, "11000000");
      assert.equal(res[0]?.categorySrc, "pluggy");
    } finally {
      cleanup();
    }
  });

  it("filters uncategorized rows with \"none\"", () => {
    const { store, cleanup } = setupStore();
    try {
      store.replaceAccount("acc-bank", "conn-1", [
        tx({ id: "uncat", accountId: "acc-bank", categoryId: null }),
        tx({ id: "cat", accountId: "acc-bank", categoryId: "11010000" }),
      ], null);
      const res = store.query({ ...WIDE, categories: ["none"] });
      assert.equal(res.length, 1);
      assert.equal(res[0]?.id, "uncat");
    } finally {
      cleanup();
    }
  });

  it("mixes \"none\" with real ids", () => {
    const { store, cleanup } = setupStore();
    try {
      store.replaceAccount("acc-bank", "conn-1", [
        tx({ id: "uncat", accountId: "acc-bank", categoryId: null }),
        tx({ id: "cat", accountId: "acc-bank", categoryId: "11010000" }),
        tx({ id: "other", accountId: "acc-bank", categoryId: "02010000" }),
      ], null);
      const res = store.query({ ...WIDE, categories: ["none", "11000000"] });
      const ids = res.map((r) => r.id).sort();
      assert.deepEqual(ids, ["cat", "uncat"]);
    } finally {
      cleanup();
    }
  });

  it("never joins two rows that both have no document", () => {
    const { db, store, cleanup } = setupStore();
    try {
      db.prepare("INSERT INTO userdata.counterparty_categories (document, category, origin, created_at) VALUES ('12345678000199', '02000000', 'learned', '2026-07-26')").run();

      store.replaceAccount("acc-bank", "conn-1", [
        tx({ id: "nodoc-1", accountId: "acc-bank", categoryId: null, document: null }),
        tx({ id: "nodoc-2", accountId: "acc-bank", categoryId: null, document: null }),
      ], null);

      const res = store.query(WIDE);
      for (const row of res) {
        assert.equal(row.category, null);
        assert.equal(row.categorySrc, null);
      }
    } finally {
      cleanup();
    }
  });

  it("writes an override for every known id and names the rest", () => {
    const { db, store, cleanup } = setupStore();
    try {
      store.replaceAccount("acc-bank", "conn-1", [tx({ id: "known-1" }), tx({ id: "known-2" })], null);
      const writer = createCategoryWriter(db, { now: () => new Date("2026-07-26T12:00:00.000Z") });
      const res = writer.setCategory(["known-1", "known-2", "unknown-99"], "01000000");

      assert.equal(res.updated, 2);
      assert.deepEqual(res.unknownIds, ["unknown-99"]);

      const queryRes = store.byIds(["known-1", "known-2"]);
      assert.equal(queryRes[0]?.category, "01000000");
      assert.equal(queryRes[1]?.category, "01000000");
    } finally {
      cleanup();
    }
  });

  it("overwrites an earlier override", () => {
    const { db, store, cleanup } = setupStore();
    try {
      store.replaceAccount("acc-bank", "conn-1", [tx({ id: "tx-over" })], null);
      const writer = createCategoryWriter(db);
      writer.setCategory(["tx-over"], "01000000");
      writer.setCategory(["tx-over"], "02000000");

      const [res] = store.byIds(["tx-over"]);
      assert.equal(res?.category, "02000000");
    } finally {
      cleanup();
    }
  });

  it("replaces a learned counterparty row and flips it to manual", () => {
    const { db, cleanup } = setupStore();

    try {
      const cnpj = "12345678000190";
      db.prepare("INSERT INTO userdata.counterparty_categories (document, category, origin, created_at) VALUES (?, '05000000', 'learned', '2026-07-26')").run(cnpj);
      const writer = createCategoryWriter(db);
      writer.setCounterpartyCategory(cnpj, "02000000");

      const row = db.prepare("SELECT * FROM userdata.counterparty_categories WHERE document = ?").get(cnpj) as Record<string, unknown>;
      assert.equal(row["category"], "02000000");
      assert.equal(row["origin"], "manual");
    } finally {
      cleanup();
    }
  });

  it("counts the rows a counterparty write now answers for", () => {
    const { db, store, cleanup } = setupStore();
    try {
      const cnpj = "12345678000190";
      store.replaceAccount("acc-bank", "conn-1", [
        tx({ id: "t1", document: cnpj }),
        tx({ id: "t2", document: cnpj }),
        tx({ id: "t3", document: cnpj }),
      ], null);

      const writer = createCategoryWriter(db);
      writer.setCategory(["t1"], "01000000"); // t1 has override, so affected should be 2

      const res = writer.setCounterpartyCategory(cnpj, "02000000");
      assert.equal(res.affected, 2);
    } finally {
      cleanup();
    }
  });
});


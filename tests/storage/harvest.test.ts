import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { openDatabases } from "../../src/storage/db.ts";
import { createTransactionStore } from "../../src/storage/transactions.ts";
import { fakeLogger } from "../fakes/fake-logger.ts";
import { tx } from "../fakes/transaction-builder.ts";

function setupStore() {
  const dir = mkdtempSync(join(tmpdir(), "cata-harvest-test-"));
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

describe("category harvesting during walk", () => {
  it("snapshots every categorized row", () => {
    const { db, store, cleanup } = setupStore();
    try {
      const row = tx({ id: "tx-cat", categoryId: "11010000" });
      store.replaceAccount("acc-1", "conn-1", [row], "1");

      const snap = db.prepare("SELECT * FROM userdata.category_snapshot WHERE transaction_id = 'tx-cat'").get() as Record<string, unknown>;
      assert.ok(snap);
      assert.equal(snap["category_id"], "11010000");
      assert.equal(snap["top_category_id"], "11000000");
      assert.equal(snap["harvested_at"], "2026-07-26T12:00:00.000Z");
    } finally {
      cleanup();
    }
  });

  it("never writes a null over a remembered category", () => {
    const { db, store, cleanup } = setupStore();
    try {
      store.replaceAccount("acc-1", "conn-1", [tx({ id: "a", categoryId: "11010000" })], "1");
      store.replaceAccount("acc-1", "conn-1", [tx({ id: "a", categoryId: null })], "2");

      const row = db.prepare("SELECT top_category_id FROM userdata.category_snapshot WHERE transaction_id = 'a'").get() as Record<string, unknown>;
      assert.equal(row?.["top_category_id"], "11000000");
    } finally {
      cleanup();
    }
  });

  it("updates the snapshot when Pluggy changes its mind", () => {
    const { db, store, cleanup } = setupStore();
    try {
      store.replaceAccount("acc-1", "conn-1", [tx({ id: "a", categoryId: "11010000" })], "1");
      store.replaceAccount("acc-1", "conn-1", [tx({ id: "a", categoryId: "02010000" })], "2");

      const row = db.prepare("SELECT top_category_id FROM userdata.category_snapshot WHERE transaction_id = 'a'").get() as Record<string, unknown>;
      assert.equal(row?.["top_category_id"], "02000000");
    } finally {
      cleanup();
    }
  });

  it("learns a CNPJ's category and leaves CPFs alone", () => {
    const { db, store, cleanup } = setupStore();
    try {
      const cnpj = "12345678000190";
      const cpf = "12345678900";
      store.replaceAccount("acc-1", "conn-1", [
        tx({ id: "tx-cnpj", categoryId: "05010000", document: cnpj }),
        tx({ id: "tx-cpf", categoryId: "05010000", document: cpf }),
      ], "1");

      const cnpjRow = db.prepare("SELECT * FROM userdata.counterparty_categories WHERE document = ?").get(cnpj) as Record<string, unknown>;
      assert.ok(cnpjRow);
      assert.equal(cnpjRow["category"], "05000000");
      assert.equal(cnpjRow["origin"], "learned");

      const cpfRow = db.prepare("SELECT * FROM userdata.counterparty_categories WHERE document = ?").get(cpf);
      assert.equal(cpfRow, undefined);
    } finally {
      cleanup();
    }
  });

  it("recomputes the learned map wholesale without touching manual rows", () => {
    const { db, store, cleanup } = setupStore();
    try {
      const cnpjManual = "99999999000199";
      db.prepare("INSERT INTO userdata.counterparty_categories (document, category, origin, created_at) VALUES (?, '01000000', 'manual', '2026-07-26')").run(cnpjManual);

      store.replaceAccount("acc-1", "conn-1", [
        tx({ id: "tx-manual-cnpj", categoryId: "05010000", document: cnpjManual }),
      ], "1");

      const manualRow = db.prepare("SELECT * FROM userdata.counterparty_categories WHERE document = ?").get(cnpjManual) as Record<string, unknown>;
      assert.equal(manualRow["category"], "01000000");
      assert.equal(manualRow["origin"], "manual");
    } finally {
      cleanup();
    }
  });

  it("rolls back both files when a row is rejected", () => {
    const { db, store, cleanup } = setupStore();
    try {
      assert.throws(() => {
        store.replaceAccount("acc-1", "conn-1", [
          tx({ id: "valid", categoryId: "11010000" }),
          tx({ id: "invalid", localDate: null as never, categoryId: "02010000" }),
        ], "1");
      });

      const snap = db.prepare("SELECT COUNT(*) AS count FROM userdata.category_snapshot").get() as Record<string, unknown>;
      assert.equal(snap["count"], 0);
    } finally {
      cleanup();
    }
  });
});

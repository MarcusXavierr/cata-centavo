import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { readLocalState } from "../../src/storage/diagnostics.ts";
import { openDatabase, openDatabases } from "../../src/storage/db.ts";
import { CACHE_MIGRATIONS } from "../../src/storage/migrations.ts";

function freshDb() {
  return openDatabase({ path: ":memory:", migrations: CACHE_MIGRATIONS, policy: "rebuild" });
}

function insertTransactionSync(
  db: ReturnType<typeof freshDb>,
  accountId: string,
  connectionId: string,
  lastUpdatedAt: string | null,
): void {
  db.prepare("INSERT INTO transaction_sync (account_id, connection_id, last_updated_at) VALUES (?, ?, ?)").run(
    accountId,
    connectionId,
    lastUpdatedAt,
  );
}

function insertTransaction(db: ReturnType<typeof freshDb>, id: string, accountId: string, localDate: string): void {
  db.prepare(
    `INSERT INTO transactions (
      id, account_id, connection_id, account_type, account_subtype, occurred_at, local_date,
      amount_cents, currency, description, description_norm
    ) VALUES (?, ?, 'conn-1', 'BANK', 'CHECKING_ACCOUNT', ?, ?, 100, 'BRL', 'x', 'x')`,
  ).run(id, accountId, `${localDate}T00:00:00.000Z`, localDate);
}

describe("readLocalState", () => {
  it("reads zeroes and nulls on a fresh database, without throwing", () => {
    const db = freshDb();

    const state = readLocalState(db);

    assert.equal(state.accountsWalked, 0);
    assert.equal(state.newestLocalDate, null);
    assert.equal(state.perConnection.size, 0);
    assert.equal(state.snapshotRows, 0);
    assert.equal(state.counterpartyDocuments, 0);
    assert.equal(state.cacheVersion, 2);
  });

  it("seeds the MCC table via migration, so mccRows is non-zero even on a fresh database", () => {
    const state = readLocalState(freshDb());

    assert.ok(state.mccRows > 0);
  });

  it("counts accounts and the newest transaction on a populated database", () => {
    const db = freshDb();
    insertTransactionSync(db, "acc-1", "conn-1", "2026-07-20T00:00:00.000Z");
    insertTransactionSync(db, "acc-2", "conn-1", "2026-07-22T00:00:00.000Z");
    insertTransaction(db, "tx-1", "acc-1", "2026-07-20");
    insertTransaction(db, "tx-2", "acc-2", "2026-07-25");

    const state = readLocalState(db);

    assert.equal(state.accountsWalked, 2);
    assert.equal(state.newestLocalDate, "2026-07-25");
  });

  it("groups accounts and the oldest walk by connection", () => {
    const db = freshDb();
    insertTransactionSync(db, "acc-1", "conn-1", "2026-07-20T00:00:00.000Z");
    insertTransactionSync(db, "acc-2", "conn-1", "2026-07-22T00:00:00.000Z");
    insertTransactionSync(db, "acc-3", "conn-2", "2026-07-24T00:00:00.000Z");

    const state = readLocalState(db);

    assert.deepEqual(state.perConnection.get("conn-1"), { accounts: 2, oldestWalk: "2026-07-20T00:00:00.000Z" });
    assert.deepEqual(state.perConnection.get("conn-2"), { accounts: 1, oldestWalk: "2026-07-24T00:00:00.000Z" });
  });

  it("reports an empty path for an in-memory database", () => {
    const db = freshDb();

    const state = readLocalState(db);

    assert.equal(state.cacheDb, "");
    assert.equal(state.dataDb, "");
  });

  it("reads the real cache.db and data.db paths off a file-backed connection", () => {
    const dir = mkdtempSync(join(tmpdir(), "cata-centavo-diagnostics-"));
    const cacheDb = join(dir, "cache.db");
    const dataDb = join(dir, "data.db");
    const databases = openDatabases({ cacheDb, dataDb, logFile: join(dir, "log") });

    try {
      const state = readLocalState(databases.db);

      assert.equal(state.cacheDb, cacheDb);
      assert.equal(state.dataDb, dataDb);
    } finally {
      databases.close();
    }
  });

  it("counts the userdata categorization tables", () => {
    const db = freshDb();
    db.exec(`
      INSERT INTO userdata.category_snapshot (transaction_id, category_id, top_category_id, harvested_at)
      VALUES ('tx-1', '01000000', '01000000', '2026-07-25T00:00:00.000Z')
    `);
    db.exec(`
      INSERT INTO userdata.counterparty_categories (document, category, origin, samples, agreeing, created_at)
      VALUES ('00000000000', '01000000', 'learned', 3, 3, '2026-07-25T00:00:00.000Z')
    `);

    const state = readLocalState(db);

    assert.equal(state.snapshotRows, 1);
    assert.equal(state.counterpartyDocuments, 1);
  });
});

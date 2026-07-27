import type { DatabaseSync } from "node:sqlite";

import { schemaVersion } from "./db.ts";

export type LocalState = {
  readonly cacheDb: string;
  readonly dataDb: string;
  readonly cacheVersion: number;
  readonly dataVersion: number;
  readonly accountsWalked: number;
  readonly newestLocalDate: string | null;
  readonly perConnection: ReadonlyMap<string, { readonly accounts: number; readonly oldestWalk: string | null }>;
  readonly snapshotRows: number;
  readonly counterpartyDocuments: number;
  readonly mccRows: number;
};

/**
 * What `doctor` reads off disk, without touching the network. `doctor` runs
 * precisely when things are broken, so a diagnostic that throws on a fresh
 * install would be worse than useless — every count here reads as zero, and
 * every date as `null`, rather than raising.
 */
export function readLocalState(db: DatabaseSync): LocalState {
  const paths = readAttachedPaths(db);
  return {
    cacheDb: paths.get("main") ?? "",
    dataDb: paths.get("userdata") ?? "",
    cacheVersion: schemaVersion(db),
    dataVersion: schemaVersion(db, "userdata"),
    accountsWalked: countAccountsWalked(db),
    newestLocalDate: readNewestLocalDate(db),
    perConnection: readPerConnection(db),
    snapshotRows: countRows(db, "userdata.category_snapshot"),
    counterpartyDocuments: countRows(db, "userdata.counterparty_categories"),
    mccRows: countRows(db, "mcc_categories"),
  };
}

function countRows(db: DatabaseSync, table: "userdata.category_snapshot" | "userdata.counterparty_categories" | "mcc_categories"): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
  return Number(row?.["n"] ?? 0);
}

function countAccountsWalked(db: DatabaseSync): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM transaction_sync").get();
  return Number(row?.["n"] ?? 0);
}

function readNewestLocalDate(db: DatabaseSync): string | null {
  const row = db.prepare("SELECT MAX(local_date) AS newest FROM transactions").get();
  return stringOrNull(row?.["newest"]);
}

function readPerConnection(db: DatabaseSync): ReadonlyMap<string, { readonly accounts: number; readonly oldestWalk: string | null }> {
  const rows = db
    .prepare(
      `SELECT connection_id, COUNT(*) AS accounts, MIN(last_updated_at) AS oldest_walk
       FROM transaction_sync
       GROUP BY connection_id`,
    )
    .all() as Record<string, unknown>[];

  return new Map(
    rows.map((row) => [
      String(row["connection_id"]),
      { accounts: Number(row["accounts"]), oldestWalk: stringOrNull(row["oldest_walk"]) },
    ]),
  );
}

/** The file paths of `main` (`cache.db`) and `userdata` (`data.db`), straight off the open connection. */
function readAttachedPaths(db: DatabaseSync): ReadonlyMap<string, string> {
  const rows = db.prepare("PRAGMA database_list").all() as Record<string, unknown>[];
  return new Map(rows.map((row) => [String(row["name"]), String(row["file"])]));
}

function stringOrNull(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return String(value);
}

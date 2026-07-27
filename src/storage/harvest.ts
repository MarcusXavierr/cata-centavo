import type { DatabaseSync } from "node:sqlite";

import type { CategoryId } from "../core/category.ts";
import type { Clock, Logger } from "../core/contracts.ts";
import { learnCounterparties } from "../core/counterparty.ts";
import { topCategoryOf } from "../core/taxonomy.ts";
import type { Transaction } from "../core/transaction.ts";
import { DERIVED_CATEGORY, DERIVED_COLUMNS } from "./category-sql.ts";

const SNAPSHOT_UPSERT = `
  INSERT INTO userdata.category_snapshot (transaction_id, category_id, top_category_id, harvested_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(transaction_id) DO UPDATE SET
    category_id = excluded.category_id,
    top_category_id = excluded.top_category_id,
    harvested_at = excluded.harvested_at
`;

const LEARNED_INSERT = `
  INSERT INTO userdata.counterparty_categories (document, category, origin, samples, agreeing, created_at)
  VALUES (?, ?, 'learned', ?, ?, ?)
  ON CONFLICT(document) DO NOTHING
`;

/** Every labelled counterparty row we hold, read through the full derivation. */
const LABELLED_ROWS = `SELECT t.document AS document, ${DERIVED_CATEGORY} AS category
  FROM (SELECT t.*, ${DERIVED_COLUMNS} FROM transactions t WHERE t.document IS NOT NULL) t`;

export type HarvestOptions = {
  readonly db: DatabaseSync;
  readonly rows: readonly Transaction[];
  readonly log: Logger;
  readonly clock: Clock;
};

/**
 * Copy the provider's enrichment into `data.db` while it still arrives.
 *
 * This runs inside the walk's open transaction, with every row already in hand.
 * No user action, no separate command, no schedule — because the enrichment is
 * expected to stop and the walk that discovers it has stopped is the same walk
 * that would otherwise overwrite the history with NULL.
 *
 * SQLite's atomic commit across attached databases does not hold under WAL,
 * which `openDatabase` enables, so a crash can commit `cache.db` and not
 * `userdata`. That is survivable only because of the asymmetry in
 * `snapshotCategories`: the worst case is one walk's new labels lost, and the
 * next walk rewrites them.
 */
export function harvest(options: HarvestOptions): void {
  snapshotCategories(options);
  relearnCounterparties(options);
}

/**
 * The snapshot only ever gains.
 *
 * A row arriving with no category writes nothing, so a walk that lands after
 * the plan drops to free cannot erase what an earlier walk remembered. That one
 * asymmetry is what makes the history survive.
 */
function snapshotCategories(options: HarvestOptions): void {
  const upsert = options.db.prepare(SNAPSHOT_UPSERT);
  const now = options.clock.now().toISOString();

  for (const row of options.rows) {
    if (row.categoryId !== null) {
      upsert.run(row.id, row.categoryId, topCategoryFor(row, options.log), now);
    }
  }
}

/**
 * Recomputed wholesale rather than incrementally.
 *
 * It is affordable at this size, and it means a manual correction, a re-sync
 * and a cache rebuild all converge on the same map instead of accumulating
 * drift. The `DELETE` touches only learned rows and `DO NOTHING` then declines
 * to overwrite a manual row for a document that would also have been learned,
 * so a human's answer always outlives the inference.
 */
function relearnCounterparties(options: HarvestOptions): void {
  const rows = options.db.prepare(LABELLED_ROWS).all() as {
    readonly document: string | null;
    readonly category: string | null;
  }[];
  const learned = learnCounterparties(rows);

  options.db.exec("DELETE FROM userdata.counterparty_categories WHERE origin = 'learned'");

  const insert = options.db.prepare(LEARNED_INSERT);
  const now = options.clock.now().toISOString();
  for (const item of learned) {
    insert.run(item.document, item.category, item.samples, item.agreeing, now);
  }
}

/**
 * The roll-up, with the unknown leaf reported rather than thrown.
 *
 * The tree ships as code, so a category the provider adds tomorrow is absent by
 * construction. Costing that row its group is right; costing the whole
 * account's walk is not (design D3).
 */
export function topCategoryFor(row: Transaction, log: Logger): CategoryId | null {
  const top = topCategoryOf(row.categoryId);
  if (top === null && row.categoryId !== null) {
    log.warn({ transactionId: row.id, categoryId: row.categoryId }, "Unknown category, left ungrouped");
  }
  return top;
}

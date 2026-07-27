import type { DatabaseSync } from "node:sqlite";

import type { CategoryId } from "../core/category.ts";
import type { CategoryWriter, Clock } from "../core/contracts.ts";
import { isDocument } from "../core/counterparty.ts";

const systemClock: Clock = { now: () => new Date() };

const OVERRIDE_UPSERT = `
  INSERT INTO userdata.category_overrides (transaction_id, category, created_at)
  VALUES (?, ?, ?)
  ON CONFLICT(transaction_id) DO UPDATE SET
    category = excluded.category,
    created_at = excluded.created_at
`;

const COUNTERPARTY_UPSERT = `
  INSERT INTO userdata.counterparty_categories (document, category, origin, samples, agreeing, created_at)
  VALUES (?, ?, 'manual', NULL, NULL, ?)
  ON CONFLICT(document) DO UPDATE SET
    category = excluded.category,
    origin = 'manual',
    samples = NULL,
    agreeing = NULL,
    created_at = excluded.created_at
`;

/**
 * How many cached rows this counterparty now answers for.
 *
 * Rows carrying an override are excluded, because an override outranks the
 * counterparty branch and those rows do not move. Counting them would overstate
 * the blast radius in the one number a user reads to decide whether a write was
 * broader than they meant (ADR §12.6).
 */
const AFFECTED_COUNT = `
  SELECT COUNT(*) AS affected FROM transactions t
  WHERE t.document = ?
    AND NOT EXISTS (SELECT 1 FROM userdata.category_overrides o WHERE o.transaction_id = t.id)
`;

/** Everything both writes need, prepared once when the writer is built. */
type WriterContext = {
  readonly db: DatabaseSync;
  readonly clock: Clock;
  readonly override: ReturnType<DatabaseSync["prepare"]>;
  readonly counterparty: ReturnType<DatabaseSync["prepare"]>;
  readonly affected: ReturnType<DatabaseSync["prepare"]>;
};

export function createCategoryWriter(db: DatabaseSync, clock: Clock = systemClock): CategoryWriter {
  const context: WriterContext = {
    db,
    clock,
    override: db.prepare(OVERRIDE_UPSERT),
    counterparty: db.prepare(COUNTERPARTY_UPSERT),
    affected: db.prepare(AFFECTED_COUNT),
  };

  return {
    setCategory: (ids, category) => setCategory(context, ids, category),
    setCounterpartyCategory: (document, category) => setCounterpartyCategory(context, document, category),
  };
}

/**
 * The ids we hold, so unknown ones can be reported rather than raised. An agent
 * working from a stale listing should get its known rows written and the rest
 * named back (PRD item 4).
 */
function knownIds(db: DatabaseSync, ids: readonly string[]): ReadonlySet<string> {
  const sql = `SELECT id FROM transactions WHERE id IN (${placeholders(ids.length)})`;
  const rows = db.prepare(sql).all(...ids) as { readonly id: string }[];
  return new Set(rows.map((row) => String(row.id)));
}

function setCategory(
  context: WriterContext,
  ids: readonly string[],
  category: CategoryId,
): { readonly updated: number; readonly unknownIds: readonly string[] } {
  if (ids.length === 0) {
    return { updated: 0, unknownIds: [] };
  }

  const known = knownIds(context.db, ids);
  const unknownIds = ids.filter((id) => !known.has(id));
  if (known.size === 0) {
    return { updated: 0, unknownIds };
  }

  const now = context.clock.now().toISOString();
  inTransaction(context.db, () => {
    for (const id of known) {
      context.override.run(id, category, now);
    }
  });

  return { updated: known.size, unknownIds };
}

function setCounterpartyCategory(
  context: WriterContext,
  document: string,
  category: CategoryId,
): { readonly affected: number } {
  const digits = document.replace(/\D/gu, "");
  if (!isDocument(digits)) {
    throw new Error("document must be an 11-digit CPF or 14-digit CNPJ");
  }

  const now = context.clock.now().toISOString();
  let affected = 0;
  inTransaction(context.db, () => {
    context.counterparty.run(digits, category, now);
    const row = context.affected.get(digits) as { readonly affected: number | string } | undefined;
    affected = Number(row?.affected ?? 0);
  });

  return { affected };
}

function inTransaction(db: DatabaseSync, work: () => void): void {
  db.exec("BEGIN");
  try {
    work();
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

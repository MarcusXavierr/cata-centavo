import type { DatabaseSync } from "node:sqlite";

import type { CategoryId } from "../core/category.ts";

import type { CategoryFilterValue, Clock, Logger, TransactionFilter, TransactionStore } from "../core/contracts.ts";
import type { DerivedTransaction, Transaction } from "../core/transaction.ts";
import { DERIVED_CATEGORY, DERIVED_COLUMNS } from "./category-sql.ts";
import { harvest } from "./harvest.ts";
import { rowToDerived, transactionValues } from "./transaction-row.ts";

const TRANSACTION_COLUMNS = [
  "id", "account_id", "connection_id", "account_type", "account_subtype",
  "occurred_at", "local_date", "amount_cents", "currency", "original_amount_cents",
  "original_currency", "description", "description_norm", "category_id", "document",
  "counterparty_name", "payment_method", "mcc", "bill_id", "instalment_number",
  "bill_forecast_date", "instalment_total", "purchase_date", "top_category_id",
] as const;

function placeholders(n: number): string {
  return Array(n).fill("?").join(", ");
}

const TRANSACTION_INSERT = `
  INSERT INTO transactions (${TRANSACTION_COLUMNS.join(", ")})
  VALUES (${placeholders(TRANSACTION_COLUMNS.length)})
  ON CONFLICT(id) DO UPDATE SET
    account_id = excluded.account_id,
    connection_id = excluded.connection_id,
    account_type = excluded.account_type,
    account_subtype = excluded.account_subtype,
    occurred_at = excluded.occurred_at,
    local_date = excluded.local_date,
    amount_cents = excluded.amount_cents,
    currency = excluded.currency,
    original_amount_cents = excluded.original_amount_cents,
    original_currency = excluded.original_currency,
    description = excluded.description,
    description_norm = excluded.description_norm,
    category_id = excluded.category_id,
    document = excluded.document,
    counterparty_name = excluded.counterparty_name,
    payment_method = excluded.payment_method,
    mcc = excluded.mcc,
    bill_id = excluded.bill_id,
    instalment_number = excluded.instalment_number,
    bill_forecast_date = excluded.bill_forecast_date,
    instalment_total = excluded.instalment_total,
    purchase_date = excluded.purchase_date,
    top_category_id = excluded.top_category_id
`;

const systemClock: Clock = { now: () => new Date() };

export function createTransactionStore(db: DatabaseSync, log: Logger, clock: Clock = systemClock): TransactionStore {
  const insert = db.prepare(TRANSACTION_INSERT);
  const deleteMissing = db.prepare(
    "DELETE FROM transactions WHERE account_id = ? AND id NOT IN (SELECT value FROM json_each(?))",
  );
  const stamp = db.prepare(`
    INSERT INTO transaction_sync (account_id, connection_id, last_updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(account_id) DO UPDATE SET
      connection_id = excluded.connection_id,
      last_updated_at = excluded.last_updated_at
  `);

  return {
    syncedLastUpdatedAt: (accountId) => readFreshness(db, accountId),
    replaceAccount: (accountId, connectionId, rows, lastUpdatedAt) => {
      return replaceAccount({ db, insert, deleteMissing, stamp, accountId, connectionId, rows, lastUpdatedAt, log, clock });
    },
    query: (filter) => queryTransactions(db, filter),
    byIds: (ids) => findByIds(db, ids),
    cardRows: (accountId) => findCardRows(db, accountId),
    dataThrough: (accountIds, today) => readDataThrough(db, accountIds, today),
  };
}

type ReplaceAccountOptions = {
  readonly db: DatabaseSync;
  readonly insert: ReturnType<DatabaseSync["prepare"]>;
  readonly deleteMissing: ReturnType<DatabaseSync["prepare"]>;
  readonly stamp: ReturnType<DatabaseSync["prepare"]>;
  readonly accountId: string;
  readonly connectionId: string;
  readonly rows: readonly Transaction[];
  readonly lastUpdatedAt: string | null;
  readonly log: Logger;
  readonly clock: Clock;
};

function replaceAccount(options: ReplaceAccountOptions): number {
  options.db.exec("BEGIN");
  try {
    for (const row of options.rows) {
      options.insert.run(...transactionValues(row, options.log));
    }
    const deleteResult = options.deleteMissing.run(options.accountId, JSON.stringify(options.rows.map((row) => row.id)));
    options.stamp.run(options.accountId, options.connectionId, options.lastUpdatedAt);
    harvest({ db: options.db, rows: options.rows, log: options.log, clock: options.clock });
    options.db.exec("COMMIT");
    return Number(deleteResult.changes);
  } catch (error) {
    options.db.exec("ROLLBACK");
    throw error;
  }
}

function queryTransactions(db: DatabaseSync, filter: TransactionFilter): readonly DerivedTransaction[] {
  // Stryker disable next-line ConditionalExpression,BlockStatement: an empty SQL IN list is already empty in SQLite; this guard keeps the domain contract explicit.
  if (filter.accountIds.length === 0) {
    return [];
  }

  const query = buildQuery(filter);
  const rows = db.prepare(query.sql).all(...query.parameters) as Record<string, unknown>[];
  return rows.map((row) => rowToDerived(row));
}

/**
 * The cheap filters run inside the CTE so the six correlated subqueries of
 * `DERIVED_COLUMNS` only touch rows that already survived them. The category
 * filter has to run outside, because it compares the derived value.
 */
function buildQuery(filter: TransactionFilter): { readonly sql: string; readonly parameters: readonly (string | number)[] } {
  const conditions = [
    `t.account_id IN (${placeholders(filter.accountIds.length)})`,
    "t.local_date >= ?",
    "t.local_date <= ?",
  ];
  const parameters: (string | number)[] = [...filter.accountIds, filter.from, filter.to];
  addAmountFilters(conditions, parameters, filter.minAmountCents, filter.maxAmountCents);
  addAccountFilters(conditions, parameters, filter.accountType, filter.accountSubtype);
  addKeysetFilter(conditions, parameters, filter.after);

  let sql = `WITH derived AS (
    SELECT t.${TRANSACTION_COLUMNS.join(", t.")}, ${DERIVED_COLUMNS}
    FROM transactions t
    WHERE ${conditions.join(" AND ")}
  ) SELECT * FROM derived`;

  if (filter.categories !== undefined) {
    const category = categoryCondition(filter.categories);
    sql += ` WHERE ${category.sql}`;
    parameters.push(...category.parameters);
  }

  sql += " ORDER BY local_date DESC, id DESC";

  if (filter.limit !== undefined) {
    sql += " LIMIT ?";
    parameters.push(filter.limit);
  }

  return { sql, parameters };
}

function categoryCondition(categories: readonly CategoryFilterValue[]): { readonly sql: string; readonly parameters: readonly string[] } {
  // Stryker disable next-line ConditionalExpression,BlockStatement: an empty category filter must remain an explicit no-match query.
  if (categories.length === 0) {
    return { sql: "1 = 0", parameters: [] };
  }
  const ids = categories.filter((value): value is CategoryId => value !== "none");
  const wantsNone = categories.length !== ids.length;

  const clauses: string[] = [];
  if (ids.length > 0) {
    clauses.push(`${DERIVED_CATEGORY} IN (${placeholders(ids.length)})`);
  }
  if (wantsNone) {
    clauses.push(`${DERIVED_CATEGORY} IS NULL`);
  }
  return { sql: `(${clauses.join(" OR ")})`, parameters: ids };
}

function addAmountFilters(
  conditions: string[],
  parameters: Array<string | number>,
  minAmountCents: number | undefined,
  maxAmountCents: number | undefined,
): void {
  if (minAmountCents !== undefined) {
    conditions.push("t.amount_cents >= ?");
    parameters.push(minAmountCents);
  }
  if (maxAmountCents !== undefined) {
    conditions.push("t.amount_cents <= ?");
    parameters.push(maxAmountCents);
  }
}

function addAccountFilters(
  conditions: string[],
  parameters: Array<string | number>,
  accountType: Transaction["accountType"] | undefined,
  accountSubtype: string | undefined,
): void {
  if (accountType !== undefined) {
    conditions.push("t.account_type = ?");
    parameters.push(accountType);
  }
  if (accountSubtype !== undefined) {
    conditions.push("t.account_subtype = ?");
    parameters.push(accountSubtype);
  }
}

function addKeysetFilter(
  conditions: string[],
  parameters: Array<string | number>,
  after: TransactionFilter["after"],
): void {
  if (after === undefined) {
    return;
  }
  conditions.push("(t.local_date, t.id) < (?, ?)");
  parameters.push(after.localDate, after.id);
}

function findByIds(db: DatabaseSync, ids: readonly string[]): readonly DerivedTransaction[] {
  // Stryker disable next-line ConditionalExpression,BlockStatement: the details boundary rejects empty ids, and this storage guard avoids generating an empty IN list.
  if (ids.length === 0) {
    return [];
  }
  const sql = `WITH derived AS (
    SELECT t.${TRANSACTION_COLUMNS.join(", t.")}, ${DERIVED_COLUMNS}
    FROM transactions t
    WHERE t.id IN (${placeholders(ids.length)})
  ) SELECT * FROM derived ORDER BY local_date DESC, id DESC`;
  const rows = db.prepare(sql).all(...ids) as Record<string, unknown>[];
  return rows.map((row) => rowToDerived(row));
}

function findCardRows(db: DatabaseSync, accountId: string): readonly DerivedTransaction[] {
  const sql = `WITH derived AS (
    SELECT t.${TRANSACTION_COLUMNS.join(", t.")}, ${DERIVED_COLUMNS}
    FROM transactions t
    WHERE t.account_id = ?
  ) SELECT * FROM derived ORDER BY local_date, id`;
  const rows = db.prepare(sql).all(accountId) as Record<string, unknown>[];
  return rows.map((row) => rowToDerived(row));
}

function readFreshness(db: DatabaseSync, accountId: string): string | null | undefined {
  const row = db.prepare("SELECT last_updated_at FROM transaction_sync WHERE account_id = ?").get(accountId);
  if (row === undefined) {
    return undefined;
  }
  const value = row["last_updated_at"];
  // Stryker disable next-line ConditionalExpression: SQLite returns NULL for this nullable column; the undefined branch is defensive for unusual row objects.
  if (value === null || value === undefined) {
    return null;
  }
  return String(value);
}

function readDataThrough(db: DatabaseSync, accountIds: readonly string[], today: string): ReadonlyMap<string, string> {
  // Stryker disable next-line ConditionalExpression,BlockStatement: an empty SQL IN list is already empty in SQLite; this guard avoids dialect-dependent SQL.
  if (accountIds.length === 0) {
    return new Map();
  }
  const sql = `SELECT connection_id, MAX(local_date) AS through FROM transactions WHERE account_id IN (${placeholders(accountIds.length)}) AND local_date <= ? GROUP BY connection_id`;
  const rows = db.prepare(sql).all(...accountIds, today) as Record<string, unknown>[];
  return new Map(rows.map((row) => [String(row["connection_id"]), String(row["through"])]));
}

/**
 * The roll-up runs here, at insert, so SQL only ever compares a 22-valued
 * column against a 22-valued filter (design D2). Doing it at read time is what
 * let `categories: ["11000000"]` silently exclude every row tagged `11010000`.
 */

import type { DatabaseSync } from "node:sqlite";

import type { TransactionFilter, TransactionStore } from "../core/contracts.ts";
import type { Transaction } from "../core/transaction.ts";

const TRANSACTION_COLUMNS = [
  "id", "account_id", "connection_id", "account_type", "account_subtype",
  "occurred_at", "local_date", "amount_cents", "currency", "original_amount_cents",
  "original_currency", "description", "description_norm", "category_id", "document",
  "counterparty_name", "payment_method", "mcc", "bill_id", "instalment_number",
  "instalment_total", "purchase_date",
] as const;

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
    instalment_total = excluded.instalment_total,
    purchase_date = excluded.purchase_date
`;

export function createTransactionStore(db: DatabaseSync): TransactionStore {
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
      return replaceAccount({ db, insert, deleteMissing, stamp, accountId, connectionId, rows, lastUpdatedAt });
    },
    query: (filter) => queryTransactions(db, filter),
    byIds: (ids) => findByIds(db, ids),
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
};

function replaceAccount(options: ReplaceAccountOptions): number {
  options.db.exec("BEGIN");
  try {
    for (const row of options.rows) {
      options.insert.run(...transactionValues(row));
    }
    const deleteResult = options.deleteMissing.run(options.accountId, JSON.stringify(options.rows.map((row) => row.id)));
    options.stamp.run(options.accountId, options.connectionId, options.lastUpdatedAt);
    options.db.exec("COMMIT");
    return Number(deleteResult.changes);
  } catch (error) {
    options.db.exec("ROLLBACK");
    throw error;
  }
}

function queryTransactions(db: DatabaseSync, filter: TransactionFilter): readonly Transaction[] {
  // Stryker disable next-line ConditionalExpression,BlockStatement: an empty SQL IN list is already empty in SQLite; this guard keeps the domain contract explicit.
  if (filter.accountIds.length === 0) {
    return [];
  }

  const conditions = [
    `account_id IN (${placeholders(filter.accountIds.length)})`,
    "local_date >= ?",
    "local_date <= ?",
  ];
  const parameters: Array<string | number> = [...filter.accountIds, filter.from, filter.to];
  addOptionalFilters(conditions, parameters, filter);

  let sql = `SELECT ${TRANSACTION_COLUMNS.join(", ")} FROM transactions WHERE ${conditions.join(" AND ")} ORDER BY local_date DESC, id DESC`;
  if (filter.limit !== undefined) {
    sql += " LIMIT ?";
    parameters.push(filter.limit);
  }

  return db.prepare(sql).all(...parameters).map((row) => rowToTransaction(row));
}

function addOptionalFilters(
  conditions: string[],
  parameters: Array<string | number>,
  filter: TransactionFilter,
): void {
  addCategoryFilter(conditions, parameters, filter.categories);
  addAmountFilters(conditions, parameters, filter.minAmountCents, filter.maxAmountCents);
  addAccountFilters(conditions, parameters, filter.accountType, filter.accountSubtype);
  addKeysetFilter(conditions, parameters, filter.after);
}

function addCategoryFilter(
  conditions: string[],
  parameters: Array<string | number>,
  categories: readonly string[] | undefined,
): void {
  if (categories === undefined) {
    return;
  }
  // Stryker disable next-line ConditionalExpression,BlockStatement: an empty category filter must remain an explicit no-match query.
  if (categories.length === 0) {
    conditions.push("1 = 0");
    return;
  }
  conditions.push(`category_id IN (${placeholders(categories.length)})`);
  parameters.push(...categories);
}

function addAmountFilters(
  conditions: string[],
  parameters: Array<string | number>,
  minAmountCents: number | undefined,
  maxAmountCents: number | undefined,
): void {
  if (minAmountCents !== undefined) {
    conditions.push("amount_cents >= ?");
    parameters.push(minAmountCents);
  }
  if (maxAmountCents !== undefined) {
    conditions.push("amount_cents <= ?");
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
    conditions.push("account_type = ?");
    parameters.push(accountType);
  }
  if (accountSubtype !== undefined) {
    conditions.push("account_subtype = ?");
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
  conditions.push("(local_date, id) < (?, ?)");
  parameters.push(after.localDate, after.id);
}

function findByIds(db: DatabaseSync, ids: readonly string[]): readonly Transaction[] {
  // Stryker disable next-line ConditionalExpression,BlockStatement: the details boundary rejects empty ids, and this storage guard avoids generating an empty IN list.
  if (ids.length === 0) {
    return [];
  }
  const sql = `SELECT ${TRANSACTION_COLUMNS.join(", ")} FROM transactions WHERE id IN (${placeholders(ids.length)}) ORDER BY local_date DESC, id DESC`;
  return db.prepare(sql).all(...ids).map((row) => rowToTransaction(row));
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
  const rows = db.prepare(sql).all(...accountIds, today);
  return new Map(rows.map((row) => [String(row["connection_id"]), String(row["through"])]));
}

function rowToTransaction(row: Record<string, unknown>): Transaction {
  return {
    id: String(row["id"]),
    accountId: String(row["account_id"]),
    connectionId: String(row["connection_id"]),
    accountType: row["account_type"] as Transaction["accountType"],
    accountSubtype: nullableString(row["account_subtype"]),
    occurredAt: String(row["occurred_at"]),
    localDate: String(row["local_date"]),
    amountCents: Number(row["amount_cents"]),
    currency: String(row["currency"]),
    originalAmountCents: nullableNumber(row["original_amount_cents"]),
    originalCurrency: nullableString(row["original_currency"]),
    description: String(row["description"]),
    descriptionNorm: String(row["description_norm"]),
    categoryId: nullableString(row["category_id"]),
    document: nullableString(row["document"]),
    counterpartyName: nullableString(row["counterparty_name"]),
    paymentMethod: nullableString(row["payment_method"]),
    mcc: nullableString(row["mcc"]),
    billId: nullableString(row["bill_id"]),
    instalmentNumber: nullableNumber(row["instalment_number"]),
    instalmentTotal: nullableNumber(row["instalment_total"]),
    purchaseDate: nullableString(row["purchase_date"]),
  };
}

function transactionValues(row: Transaction): readonly (string | number | null)[] {
  return [
    row.id, row.accountId, row.connectionId, row.accountType, row.accountSubtype,
    row.occurredAt, row.localDate, row.amountCents, row.currency, row.originalAmountCents,
    row.originalCurrency, row.description, row.descriptionNorm, row.categoryId, row.document,
    row.counterpartyName, row.paymentMethod, row.mcc, row.billId, row.instalmentNumber,
    row.instalmentTotal, row.purchaseDate,
  ];
}

function nullableString(value: unknown): string | null {
  // Stryker disable next-line ConditionalExpression,LogicalOperator,BlockStatement: SQLite columns are NULL or concrete values; undefined is defensive input handling.
  if (value === null || value === undefined) {
    return null;
  }
  return String(value);
}

function nullableNumber(value: unknown): number | null {
  // Stryker disable next-line ConditionalExpression,LogicalOperator,BlockStatement: SQLite columns are NULL or concrete values; undefined is defensive input handling.
  if (value === null || value === undefined) {
    return null;
  }
  return Number(value);
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

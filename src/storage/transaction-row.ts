import type { Logger } from "../core/contracts.ts";
import { resolveCategory } from "../core/category-source.ts";
import type { DerivedTransaction, Transaction } from "../core/transaction.ts";
import { topCategoryFor } from "./harvest.ts";

/**
 * The codec between a SQLite row and our domain object.
 *
 * It lives apart from the store because it answers a different question: the
 * store decides *which* rows, this decides what a row *is*. Both directions are
 * here so the column list and the value list cannot drift apart.
 */

export function rowToTransaction(row: Record<string, unknown>): Transaction {
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
    billForecastDate: nullableString(row["bill_forecast_date"]),
    instalmentNumber: nullableNumber(row["instalment_number"]),
    instalmentTotal: nullableNumber(row["instalment_total"]),
    purchaseDate: nullableString(row["purchase_date"]),
  };
}

export function rowToDerived(row: Record<string, unknown>): DerivedTransaction {
  return {
    ...rowToTransaction(row),
    categoryId: nullableString(row["c_leaf"]),
    ...resolveCategory({
      override: nullableString(row["c_override"]),
      counterparty: nullableString(row["c_counterparty"]),
      pluggy: nullableString(row["c_pluggy"]),
      snapshot: nullableString(row["c_snapshot"]),
      learned: nullableString(row["c_learned"]),
      mcc: nullableString(row["c_mcc"]),
    }),
  };
}

export function transactionValues(row: Transaction, log: Logger): readonly (string | number | null)[] {
  return [
    row.id, row.accountId, row.connectionId, row.accountType, row.accountSubtype,
    row.occurredAt, row.localDate, row.amountCents, row.currency, row.originalAmountCents,
    row.originalCurrency, row.description, row.descriptionNorm, row.categoryId, row.document,
    row.counterpartyName, row.paymentMethod, row.mcc, row.billId, row.instalmentNumber,
    row.billForecastDate, row.instalmentTotal, row.purchaseDate, topCategoryFor(row, log),
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

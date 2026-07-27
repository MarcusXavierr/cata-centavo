import type { CategorySource } from "../../src/core/category-source.ts";
import { topCategoryOf } from "../../src/core/taxonomy.ts";
import type { DerivedTransaction, Transaction } from "../../src/core/transaction.ts";

/** Builds a complete synthetic transaction, with overrides for focused cases. */
export function tx(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: "transaction-1",
    accountId: "acc-1",
    connectionId: "conn-1",
    accountType: "BANK",
    accountSubtype: "CHECKING_ACCOUNT",
    occurredAt: "2026-06-15T03:00:00.000Z",
    localDate: "2026-06-15",
    amountCents: -1_000,
    currency: "BRL",
    originalAmountCents: null,
    originalCurrency: null,
    description: "Synthetic transaction",
    descriptionNorm: "SYNTHETIC TRANSACTION",
    categoryId: "01000000",
    document: null,
    counterpartyName: null,
    paymentMethod: null,
    mcc: null,
    billId: null,
    instalmentNumber: null,
    instalmentTotal: null,
    purchaseDate: null,
    ...overrides,
  };
}

/**
 * A row as the store hands it back, with the derivation already resolved.
 *
 * The default resolution is the one the enrichment produces — roll the leaf up,
 * report it as `pluggy` — so a test that only cares about amounts and dates does
 * not have to name a branch. Pass `category`/`categorySrc` explicitly to stand
 * in for an override, a learned counterparty or a row nothing could categorize.
 */
export function derived(overrides: Partial<DerivedTransaction> = {}): DerivedTransaction {
  const row = tx(overrides);
  const category = topCategoryOf(row.categoryId);
  let categorySrc: CategorySource | null = null;
  if (category !== null) {
    categorySrc = "pluggy";
  }
  return { ...row, category, categorySrc, ...overrides };
}

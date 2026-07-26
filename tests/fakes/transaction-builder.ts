import type { Transaction } from "../../src/core/transaction.ts";

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

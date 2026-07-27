import type { DerivedTransaction } from "./transaction.ts";

/**
 * Moving money between your own accounts is not spending, and paying a card
 * bill is not spending twice.
 *
 * These are leaves rather than groups because the distinction lives below the
 * 22: `05100000` (credit card payment) is excluded while its parent `05000000`
 * (Transfers) is ordinary spending. They are matched against the *durable*
 * leaf — `DerivedTransaction.categoryId`, which falls back to the snapshot —
 * so the exclusion outlives the enrichment.
 */
const SELF_TRANSFER_LEAVES: ReadonlySet<string> = new Set([
  "04000000", "04010000", "04020000", "04030000", "05100000",
]);

/** A manual correction to Same person transfer excludes the row too. */
const SELF_TRANSFER_GROUP = "04000000";

export function isSelfTransfer(row: DerivedTransaction): boolean {
  if (row.category === SELF_TRANSFER_GROUP) {
    return true;
  }
  return row.categoryId !== null && SELF_TRANSFER_LEAVES.has(row.categoryId);
}

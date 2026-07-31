import type { PlanGroup } from "./instalment-grouping.ts";

/**
 * Presentation helpers for instalment plans: the purchase day a plan reports and the total order the
 * plans leave the derivation in. Pure functions over already-grouped data; neither fetches bills,
 * resolves cycles or sums money beyond what its arguments carry.
 */

/**
 * The purchase day, emitted only when every row of the plan carries the same non-null instant.
 * A plan identified from per-row posting dates disagrees, so it reports null rather than naming a
 * posting date as the purchase date.
 */
export function purchaseDayOf(group: PlanGroup): string | null {
  const first = group[0].row.purchaseDate;
  if (first === null) {
    return null;
  }
  for (const planRow of group) {
    if (planRow.row.purchaseDate !== first) {
      return null;
    }
  }

  return first.slice(0, 10);
}

/** The fields that fix a plan's place in the output order. */
type PlanOrder = {
  readonly finalCycle: string | null;
  readonly remainingTotalCents: number;
  readonly accountId: string;
  readonly merchant: string;
};

/**
 * Total order so the tool's output is diffable: final cycle ascending with nulls last, then what is
 * still owed descending, then account and merchant. Every key is reached, so the order never ties.
 */
export function comparePlans(left: PlanOrder, right: PlanOrder): number {
  if (left.finalCycle !== right.finalCycle) {
    if (left.finalCycle === null) {
      return 1;
    }
    // Stryker disable next-line all: cycle tags begin with a digit, so the `localeCompare` fallback below sorts any non-null cycle before the "null" string the same way this explicit return does.
    if (right.finalCycle === null) {
      return -1;
    }
    return left.finalCycle.localeCompare(right.finalCycle);
  }
  if (left.remainingTotalCents !== right.remainingTotalCents) {
    return right.remainingTotalCents - left.remainingTotalCents;
  }
  if (left.accountId !== right.accountId) {
    return left.accountId.localeCompare(right.accountId);
  }

  return left.merchant.localeCompare(right.merchant);
}

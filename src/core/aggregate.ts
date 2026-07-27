import type { CategoryId } from "./category.ts";
import { isSelfTransfer } from "./self-transfer.ts";
import type { DerivedTransaction } from "./transaction.ts";

/** One rolled-up category's signed total and the rows most useful for follow-up. */
export type CategoryGroup = {
  readonly categoryId: CategoryId | null;
  readonly totalCents: number;
  readonly count: number;
  readonly sampleIds: readonly string[];
};

/** The period totals returned by the transaction domain before display labels. */
export type Aggregate = {
  readonly groups: readonly CategoryGroup[];
  readonly spentCents: number;
  readonly receivedCents: number;
  readonly upcoming: { readonly totalCents: number; readonly count: number };
};

type GroupState = {
  readonly categoryId: CategoryId | null;
  totalCents: number;
  count: number;
  rows: DerivedTransaction[];
};

/**
 * Groups by the category the derivation resolved, not by the leaf Pluggy sent.
 *
 * Those are the same answer only while the enrichment is alive. Rolling the raw
 * leaf up here instead would make a manual override invisible to the totals,
 * and would report a whole wallet as uncategorized the day the plan drops to
 * free — while the `categories` filter, which resolves the same rows in SQL,
 * kept returning them. Two totals for one question is the failure the PRD's
 * first rule names.
 */
export function aggregate(rows: readonly DerivedTransaction[], today: string): Aggregate {
  const groups = new Map<CategoryId | null, GroupState>();
  const totals = { spentCents: 0, receivedCents: 0, upcomingCents: 0, upcomingCount: 0 };

  for (const row of rows) {
    addToGroup(groups, row);
    addToTotals(totals, row, today);
  }

  return {
    groups: [...groups.values()].map(toCategoryGroup).sort(compareGroups),
    spentCents: totals.spentCents,
    receivedCents: totals.receivedCents,
    upcoming: { totalCents: totals.upcomingCents, count: totals.upcomingCount },
  };
}

function addToGroup(groups: Map<CategoryId | null, GroupState>, row: DerivedTransaction): void {
  const categoryId = row.category;
  let group = groups.get(categoryId);
  if (group === undefined) {
    group = { categoryId, totalCents: 0, count: 0, rows: [] };
    groups.set(categoryId, group);
  }
  group.totalCents += row.amountCents;
  group.count += 1;
  group.rows.push(row);
}

type Totals = {
  spentCents: number;
  receivedCents: number;
  upcomingCents: number;
  upcomingCount: number;
};

function addToTotals(totals: Totals, row: DerivedTransaction, today: string): void {
  if (row.localDate > today) {
    totals.upcomingCents += row.amountCents;
    totals.upcomingCount += 1;
    return;
  }
  if (isSelfTransfer(row)) {
    return;
  }
  if (row.amountCents < 0) {
    totals.spentCents += -row.amountCents;
    return;
  }
  if (row.amountCents > 0) {
    totals.receivedCents += row.amountCents;
  }
}

function toCategoryGroup(group: GroupState): CategoryGroup {
  const sampleRows = [...group.rows].sort(compareSampleRows).slice(0, 10);
  return {
    categoryId: group.categoryId,
    totalCents: group.totalCents,
    count: group.count,
    sampleIds: sampleRows.map((row) => row.id),
  };
}

function compareSampleRows(left: DerivedTransaction, right: DerivedTransaction): number {
  const amountDifference = Math.abs(right.amountCents) - Math.abs(left.amountCents);
  if (amountDifference !== 0) {
    return amountDifference;
  }
  return left.id.localeCompare(right.id);
}

function compareGroups(left: CategoryGroup, right: CategoryGroup): number {
  const totalDifference = Math.abs(right.totalCents) - Math.abs(left.totalCents);
  if (totalDifference !== 0) {
    return totalDifference;
  }
  return groupKey(left.categoryId).localeCompare(groupKey(right.categoryId));
}

function groupKey(categoryId: CategoryId | null): string {
  if (categoryId === null) {
    return "";
  }
  return categoryId;
}

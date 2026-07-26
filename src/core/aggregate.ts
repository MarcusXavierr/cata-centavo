import type { CategoryId } from "./category.ts";
import type { Transaction } from "./transaction.ts";

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

const SELF_TRANSFER_LEAVES: ReadonlySet<string> = new Set([
  "04000000", "04010000", "04020000", "04030000", "05100000",
]);

type GroupState = {
  readonly categoryId: CategoryId | null;
  totalCents: number;
  count: number;
  rows: Transaction[];
};

export function aggregate(
  rows: readonly Transaction[],
  rollup: ReadonlyMap<string, CategoryId>,
  today: string,
): Aggregate {
  const groups = new Map<CategoryId | null, GroupState>();
  const totals = { spentCents: 0, receivedCents: 0, upcomingCents: 0, upcomingCount: 0 };

  for (const row of rows) {
    addToGroup(groups, row, rollup);
    addToTotals(totals, row, today);
  }

  return {
    groups: [...groups.values()].map(toCategoryGroup).sort(compareGroups),
    spentCents: totals.spentCents,
    receivedCents: totals.receivedCents,
    upcoming: { totalCents: totals.upcomingCents, count: totals.upcomingCount },
  };
}

function addToGroup(
  groups: Map<CategoryId | null, GroupState>,
  row: Transaction,
  rollup: ReadonlyMap<string, CategoryId>,
): void {
  const categoryId = rolledCategory(row.categoryId, rollup);
  let group = groups.get(categoryId);
  if (group === undefined) {
    group = { categoryId, totalCents: 0, count: 0, rows: [] };
    groups.set(categoryId, group);
  }
  group.totalCents += row.amountCents;
  group.count += 1;
  group.rows.push(row);
}

function rolledCategory(categoryId: string | null, rollup: ReadonlyMap<string, CategoryId>): CategoryId | null {
  if (categoryId === null) {
    return null;
  }
  const root = rollup.get(categoryId);
  if (root === undefined) {
    throw new Error(`category ${categoryId} is absent from the taxonomy`);
  }
  return root;
}

type Totals = {
  spentCents: number;
  receivedCents: number;
  upcomingCents: number;
  upcomingCount: number;
};

function addToTotals(totals: Totals, row: Transaction, today: string): void {
  if (row.localDate > today) {
    totals.upcomingCents += row.amountCents;
    totals.upcomingCount += 1;
    return;
  }
  if (row.categoryId !== null && SELF_TRANSFER_LEAVES.has(row.categoryId)) {
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

function compareSampleRows(left: Transaction, right: Transaction): number {
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

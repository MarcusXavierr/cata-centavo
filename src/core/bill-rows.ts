import { isSelfTransfer } from "./self-transfer.ts";
import type { DerivedTransaction } from "./transaction.ts";

export type BillRowPartition = {
  readonly openCycleRows: readonly DerivedTransaction[];
  readonly futureRows: readonly DerivedTransaction[];
  readonly wrappedInstalmentRowIds: ReadonlySet<string>;
};

export type BillCommitment = {
  readonly materializedCents: number;
  readonly impliedCents: number;
  readonly futureCents: number;
  readonly committedCents: number;
};

type OpenCycleInstalmentPlan = {
  amountCents: number;
  highestInstalmentNumber: number;
  instalmentNumbers: Set<number>;
  instalmentTotal: number;
};

/** Sums posted rows in bill sign, where a purchase increases the amount due. */
export function derivePostedCents(rows: readonly DerivedTransaction[]): number {
  let postedCents = 0;
  for (const row of rows) {
    if (isSelfTransfer(row)) {
      continue;
    }
    postedCents -= row.amountCents;
  }
  return postedCents;
}

/**
 * Derives future instalments from explicit rows and each open-cycle position.
 * Only the larger total is subtracted from utilized credit.
 */
export function deriveBillCommitment(partition: BillRowPartition, utilizationCents: number): BillCommitment {
  let materializedCents = 0;
  for (const row of partition.futureRows) {
    materializedCents -= row.amountCents;
  }

  const impliedCents = deriveImpliedCents(
    partition.openCycleRows,
    partition.wrappedInstalmentRowIds,
  );

  const futureCents = Math.max(materializedCents, impliedCents);
  return {
    materializedCents,
    impliedCents,
    futureCents,
    committedCents: utilizationCents - futureCents,
  };
}

/**
 * Dedupes bulk-posted plans inside one open cycle.
 *
 * Raw `description | instalmentTotal` is safe only at this boundary. A wrapped
 * counter needs rows from two cycles, while a counter embedded in the raw
 * description gives each instalment a different key.
 *
 * The highest posted position contributes its unposted tail. Every other
 * distinct position in the same cycle contributes once.
 */
function deriveImpliedCents(
  rows: readonly DerivedTransaction[],
  wrappedInstalmentRowIds: ReadonlySet<string>,
): number {
  const plans = new Map<string, OpenCycleInstalmentPlan>();
  for (const row of rows) {
    addToOpenCyclePlans(plans, wrappedInstalmentRowIds, row);
  }

  let impliedCents = 0;
  for (const plan of plans.values()) {
    const otherOpenCycleInstalments = plan.instalmentNumbers.size - 1;
    const unpostedInstalments = plan.instalmentTotal - plan.highestInstalmentNumber;
    impliedCents -= plan.amountCents * (otherOpenCycleInstalments + unpostedInstalments);
  }
  return impliedCents;
}

function addToOpenCyclePlans(
  plans: Map<string, OpenCycleInstalmentPlan>,
  wrappedInstalmentRowIds: ReadonlySet<string>,
  row: DerivedTransaction,
): void {
  if (row.instalmentNumber === null || row.instalmentTotal === null) {
    return;
  }
  if (wrappedInstalmentRowIds.has(row.id)) {
    return;
  }

  const key = `${row.description}|${row.instalmentTotal}`;
  const plan = plans.get(key);
  if (plan === undefined) {
    plans.set(key, {
      amountCents: row.amountCents,
      highestInstalmentNumber: row.instalmentNumber,
      instalmentNumbers: new Set([row.instalmentNumber]),
      instalmentTotal: row.instalmentTotal,
    });
    return;
  }

  plan.instalmentNumbers.add(row.instalmentNumber);
  if (row.instalmentNumber > plan.highestInstalmentNumber) {
    plan.amountCents = row.amountCents;
    plan.highestInstalmentNumber = row.instalmentNumber;
  }
}

/** Separates rows that affect the open cycle from rows assigned to later cycles. */
export function partitionBillRows(
  rows: readonly DerivedTransaction[],
  openCycle: string,
  openBillId: string | null,
): BillRowPartition {
  const openCycleRows: DerivedTransaction[] = [];
  const futureRows: DerivedTransaction[] = [];
  const completedInstalmentDates = new Map<string, string>();
  const wrappedInstalmentRowIds = new Set<string>();

  for (const row of rows) {
    trackInstalmentHistory(row, completedInstalmentDates, wrappedInstalmentRowIds);

    if (belongsToOpenBill(row, openBillId)) {
      openCycleRows.push(row);
      continue;
    }

    if (row.billId !== null) {
      continue;
    }

    if (belongsToFutureCycle(row, openCycle)) {
      futureRows.push(row);
      continue;
    }

    openCycleRows.push(row);
  }

  return { openCycleRows, futureRows, wrappedInstalmentRowIds };
}

/**
 * Marks a counter that restarted after the same raw description completed.
 *
 * This has a designed false positive: if two separate instalment purchases
 * share a description and the first one completed, the second one's real
 * remainder is zeroed. The feed has no plan identifier that can separate them.
 */
function trackInstalmentHistory(
  row: DerivedTransaction,
  completedInstalmentDates: Map<string, string>,
  wrappedInstalmentRowIds: Set<string>,
): void {
  const completedDate = completedInstalmentDates.get(row.description);
  if (completedDate !== undefined && completedDate < row.localDate) {
    wrappedInstalmentRowIds.add(row.id);
  }

  if (!isCompletedInstalment(row)) {
    return;
  }

  if (completedDate === undefined || row.localDate < completedDate) {
    completedInstalmentDates.set(row.description, row.localDate);
  }
}

function isCompletedInstalment(row: DerivedTransaction): boolean {
  if (row.instalmentNumber === null || row.instalmentTotal === null) {
    return false;
  }
  return row.instalmentNumber === row.instalmentTotal;
}

function belongsToOpenBill(row: DerivedTransaction, openBillId: string | null): boolean {
  return openBillId !== null && row.billId === openBillId;
}

function belongsToFutureCycle(row: DerivedTransaction, openCycle: string): boolean {
  return row.billForecastDate === "0001-01" || (row.billForecastDate !== null && row.billForecastDate > openCycle);
}

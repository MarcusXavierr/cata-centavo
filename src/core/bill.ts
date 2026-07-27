import { isSelfTransfer } from "./self-transfer.ts";
import type { DerivedTransaction } from "./transaction.ts";

/**
 * A credit card statement as we speak of it. Money in integer cents; dates as
 * `YYYY-MM-DD` taken from the payload's UTC parts, because the connectors send
 * a calendar date wearing a time — `00:00:00.000Z` on the real one and
 * `03:00:00.000Z` on the sandbox — and in UTC−3 the second parses to the
 * previous day (ADR §14.3).
 *
 * Charges and payments are summed at the boundary rather than passed through.
 * ADR §16.2 records an unbounded nested array dominating a response; these are
 * the same shape.
 */
export type Bill = {
  readonly id: string;
  readonly closingDate: string | null;
  readonly dueDate: string;
  readonly totalCents: number;
  readonly currency: string;
  readonly minimumPaymentCents: number | null;
  readonly financeChargesCents: number;
  readonly paymentsCents: number;
  readonly paymentCount: number;
};

export const ClosingDateSource = {
  openBill: "open-bill",
  lastClosed: "last-closed",
  local: "local",
  dueDate: "due-date",
} as const;

export type ClosingDateSource = (typeof ClosingDateSource)[keyof typeof ClosingDateSource];

export type OpenCycle = {
  readonly openCycle: string;
  readonly source: ClosingDateSource;
};

export type BillRowPartition = {
  readonly openCycleRows: readonly DerivedTransaction[];
  readonly futureRows: readonly DerivedTransaction[];
};

export type BillCommitment = {
  readonly materializedCents: number;
  readonly impliedCents: number;
  readonly futureCents: number;
  readonly committedCents: number;
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

  let impliedCents = 0;
  for (const row of partition.openCycleRows) {
    if (row.instalmentNumber === null || row.instalmentTotal === null) {
      continue;
    }
    impliedCents -= row.amountCents * (row.instalmentTotal - row.instalmentNumber);
  }

  const futureCents = Math.max(materializedCents, impliedCents);
  return {
    materializedCents,
    impliedCents,
    futureCents,
    committedCents: utilizationCents - futureCents,
  };
}

const MONTH_LENGTHS: Readonly<Record<number, number>> = {
  1: 31,
  2: 28,
  3: 31,
  4: 30,
  5: 31,
  6: 30,
  7: 31,
  8: 31,
  9: 30,
  10: 31,
  11: 30,
  12: 31,
};

export function identifyOpenCycle(
  bills: readonly Bill[],
  storedDay: number | null,
  balanceDueDate: string | null,
  today: string,
): OpenCycle | null {
  const latestBill = newestBill(bills);
  if (latestBill !== null) {
    if (latestBill.closingDate !== null && latestBill.closingDate >= today) {
      return {
        openCycle: cycleOf(latestBill.dueDate),
        source: ClosingDateSource.openBill,
      };
    }

    return {
      openCycle: followingCycle(cycleOf(latestBill.dueDate)),
      source: ClosingDateSource.lastClosed,
    };
  }

  if (storedDay !== null) {
    return {
      openCycle: cycleFromStoredDay(storedDay, today),
      source: ClosingDateSource.local,
    };
  }

  if (balanceDueDate !== null) {
    return {
      openCycle: followingCycle(cycleOf(balanceDueDate)),
      source: ClosingDateSource.dueDate,
    };
  }

  return null;
}

/** Separates rows that affect the open cycle from rows assigned to later cycles. */
export function partitionBillRows(
  rows: readonly DerivedTransaction[],
  openCycle: string,
  openBillId: string | null,
): BillRowPartition {
  const openCycleRows: DerivedTransaction[] = [];
  const futureRows: DerivedTransaction[] = [];

  for (const row of rows) {
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

  return { openCycleRows, futureRows };
}

function belongsToOpenBill(row: DerivedTransaction, openBillId: string | null): boolean {
  return openBillId !== null && row.billId === openBillId;
}

function belongsToFutureCycle(row: DerivedTransaction, openCycle: string): boolean {
  return row.billForecastDate === "0001-01" || (row.billForecastDate !== null && row.billForecastDate > openCycle);
}

function newestBill(bills: readonly Bill[]): Bill | null {
  let newest: Bill | null = null;
  for (const candidate of bills) {
    if (newest === null || billDate(candidate) > billDate(newest)) {
      newest = candidate;
    }
  }
  return newest;
}

function billDate(bill: Bill): string {
  if (bill.closingDate !== null) {
    return bill.closingDate;
  }
  return bill.dueDate;
}

function cycleFromStoredDay(storedDay: number, today: string): string {
  const currentCycle = cycleOf(today);
  const year = Number(currentCycle.slice(0, 4));
  const month = Number(currentCycle.slice(5, 7));
  const closingDay = Math.min(storedDay, daysInMonth(year, month));
  const closingDate = `${currentCycle}-${String(closingDay).padStart(2, "0")}`;

  if (today >= closingDate) {
    return followingCycle(currentCycle);
  }
  return currentCycle;
}

function cycleOf(date: string): string {
  return date.slice(0, 7);
}

function followingCycle(cycle: string): string {
  let year = Number(cycle.slice(0, 4));
  let month = Number(cycle.slice(5, 7)) + 1;
  if (month === 13) {
    year += 1;
    month = 1;
  }
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2 && isLeapYear(year)) {
    return 29;
  }

  return MONTH_LENGTHS[month] ?? 31;
}

function isLeapYear(year: number): boolean {
  return year % 400 === 0 || (year % 4 === 0 && year % 100 !== 0);
}

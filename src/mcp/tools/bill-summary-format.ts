import type { Account } from "../../core/account.ts";
import {
  ClosingDateSource,
  closingCycleOf,
  newestBill,
  type Bill,
  type OpenCycle,
} from "../../core/bill.ts";
import {
  deriveBillCommitment,
  derivePostedCents,
  partitionBillRows,
} from "../../core/bill-rows.ts";
import { isSelfTransfer } from "../../core/self-transfer.ts";
import type { DerivedTransaction } from "../../core/transaction.ts";
import { toDecimal } from "../format.ts";

/** The card's own figures, always available because they come from the account itself. */
export function formatSummaryBase(account: Account): Readonly<Record<string, unknown>> {
  return {
    accountId: account.id,
    institution: account.institution,
    currency: account.currency,
    utilization: toDecimal(account.amountCents),
    creditLimit: decimalOrNull(account.credit?.limitCents ?? null),
    availableLimit: decimalOrNull(account.credit?.availableLimitCents ?? null),
  };
}

/**
 * The two estimates of the open bill, plus the gap the caller must quote.
 * They are measured differently and neither one bounds the other.
 */
export function formatDerivedFigures(
  account: Account,
  rows: readonly DerivedTransaction[],
  bills: readonly Bill[],
  openCycle: OpenCycle,
): Readonly<Record<string, unknown>> {
  let openBillId: string | null = null;
  if (openCycle.source === ClosingDateSource.openBill) {
    openBillId = newestBill(bills)?.id ?? null;
  }
  const partition = partitionBillRows(rows, openCycle.openCycle, openBillId);
  const postedCents = postedFor(openCycle, bills, partition.openCycleRows);
  const commitment = deriveBillCommitment(partition, account.amountCents);

  return {
    posted: toDecimal(postedCents),
    committed: toDecimal(commitment.committedCents),
    futureInstalments: toDecimal(commitment.futureCents),
    gap: toDecimal(Math.abs(commitment.committedCents - postedCents)),
    committedIsNegative: commitment.committedCents < 0,
    postedExceedsCommitted: postedCents > commitment.committedCents,
    topTransactions: topTransactions(partition.openCycleRows),
  };
}

function postedFor(
  openCycle: OpenCycle,
  bills: readonly Bill[],
  rows: readonly DerivedTransaction[],
): number {
  if (openCycle.source === ClosingDateSource.openBill) {
    return newestBill(bills)?.totalCents ?? derivePostedCents(rows);
  }
  return derivePostedCents(rows);
}

function topTransactions(rows: readonly DerivedTransaction[]): readonly unknown[] {
  return rows
    .filter((row) => row.amountCents < 0 && !isSelfTransfer(row))
    .toSorted(compareCharges)
    .slice(0, 5)
    .map((row) => ({
      id: row.id,
      date: row.localDate,
      description: row.description,
      amount: toDecimal(-row.amountCents),
      category: row.category,
    }));
}

function compareCharges(left: DerivedTransaction, right: DerivedTransaction): number {
  const amountOrder = left.amountCents - right.amountCents;
  if (amountOrder !== 0) {
    return amountOrder;
  }
  const dateOrder = right.localDate.localeCompare(left.localDate);
  if (dateOrder !== 0) {
    return dateOrder;
  }
  return left.id.localeCompare(right.id);
}

/** The open cycle's own dates, derived differently depending on what identified the cycle. */
export function formatCycle(
  openCycle: OpenCycle,
  bills: readonly Bill[],
  account: Account,
  storedDay: number | null,
): Readonly<Record<string, unknown>> {
  const dates = cycleDates(openCycle, bills, account, storedDay);
  return {
    openCycle: openCycle.openCycle,
    ...dates,
    closingDateSource: openCycle.source,
  };
}

type CycleDates = {
  readonly closingDate: string | null;
  readonly dueDate: string | null;
};

function cycleDates(
  openCycle: OpenCycle,
  bills: readonly Bill[],
  account: Account,
  storedDay: number | null,
): CycleDates {
  const latestBill = newestBill(bills);
  if (openCycle.source === ClosingDateSource.openBill) {
    return datesFromOpenBill(latestBill);
  }
  if (openCycle.source === ClosingDateSource.lastClosed) {
    return datesAfterClosedBill(latestBill);
  }
  if (openCycle.source === ClosingDateSource.local) {
    return datesFromLocalDay(openCycle.openCycle, storedDay, account);
  }
  return {
    closingDate: dateInCycleFrom(creditDate(account, "balanceCloseDate"), openCycle.openCycle),
    dueDate: dateInCycleFrom(creditDate(account, "balanceDueDate"), openCycle.openCycle),
  };
}

function datesFromOpenBill(bill: Bill | null): CycleDates {
  if (bill === null) {
    return { closingDate: null, dueDate: null };
  }
  return { closingDate: bill.closingDate, dueDate: bill.dueDate };
}

function datesAfterClosedBill(bill: Bill | null): CycleDates {
  if (bill === null) {
    return { closingDate: null, dueDate: null };
  }
  return {
    closingDate: shiftOneMonth(bill.closingDate),
    dueDate: shiftOneMonth(bill.dueDate),
  };
}

function datesFromLocalDay(cycle: string, storedDay: number | null, account: Account): CycleDates {
  const balanceDueDate = creditDate(account, "balanceDueDate");
  let closingDate: string | null = null;
  if (storedDay !== null) {
    closingDate = dateInCycle(closingCycleOf(cycle, storedDay, dueDayOf(balanceDueDate)), storedDay);
  }
  return {
    closingDate,
    dueDate: dateInCycleFrom(balanceDueDate, cycle),
  };
}

function dueDayOf(balanceDueDate: Date | null): number | null {
  if (balanceDueDate === null) {
    return null;
  }
  return balanceDueDate.getUTCDate();
}

function creditDate(
  account: Account,
  field: "balanceCloseDate" | "balanceDueDate",
): Date | null {
  if (account.credit === null) {
    return null;
  }
  return account.credit[field];
}

function decimalOrNull(cents: number | null): string | null {
  if (cents === null) {
    return null;
  }
  return toDecimal(cents);
}

function shiftOneMonth(date: string | null): string | null {
  if (date === null) {
    return null;
  }
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  let shiftedYear = year;
  let shiftedMonth = month + 1;
  if (shiftedMonth === 13) {
    shiftedYear += 1;
    shiftedMonth = 1;
  }
  return dateFromParts(shiftedYear, shiftedMonth, day);
}

function dateInCycleFrom(date: Date | null, cycle: string): string | null {
  if (date === null) {
    return null;
  }
  return dateInCycle(cycle, date.getUTCDate());
}

function dateInCycle(cycle: string, day: number): string {
  const year = Number(cycle.slice(0, 4));
  const month = Number(cycle.slice(5, 7));
  return dateFromParts(year, month, day);
}

function dateFromParts(year: number, month: number, day: number): string {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const clampedDay = Math.min(day, lastDay);
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(clampedDay).padStart(2, "0")}`;
}

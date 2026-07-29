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
    if (billIsOpen(latestBill, today)) {
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
      openCycle: cycleFromStoredDay(storedDay, balanceDueDate, today),
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

function billIsOpen(bill: Bill, today: string): boolean {
  if (bill.closingDate !== null) {
    return bill.closingDate >= today;
  }
  return bill.dueDate > today;
}

/** The bill the rest of the list is measured against: latest closing date, or due date when the connector omits it. */
export function newestBill(bills: readonly Bill[]): Bill | null {
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

/**
 * The open cycle from a locally stored closing day, tagged by the month it
 * falls due.
 *
 * The tag exists to be compared against `billForecastDate`, which Pluggy writes
 * against a `Bill`, and a `Bill` is identified by its `dueDate`. The other three
 * sources read that month straight off a due date; this one holds a closing day
 * and has to shift it. A card closing on the 25th and falling due on the 5th
 * closes in one month and is due in the next, so its cycle carries the later
 * tag (issue #13).
 *
 * A due day equal to the closing day shifts too. A bill cannot close and fall
 * due on the same day, because that leaves no days to pay it, so the two
 * matching means the due date is a month away rather than none.
 *
 * `balanceDueDate` supplies the due day. Without it there is no closing-to-due
 * interval anywhere in the data, so the closing month stands as the best
 * available guess rather than a refusal.
 */
function cycleFromStoredDay(storedDay: number, balanceDueDate: string | null, today: string): string {
  const closingCycle = closingCycleFromStoredDay(storedDay, today);

  if (balanceDueDate !== null && dayOf(balanceDueDate) <= storedDay) {
    return followingCycle(closingCycle);
  }
  return closingCycle;
}

/** The month the open cycle closes in. A day landing on the closing day closes it. */
function closingCycleFromStoredDay(storedDay: number, today: string): string {
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

function dayOf(date: string): number {
  return Number(date.slice(8, 10));
}

/**
 * The month a cycle closes in, read back off its tag.
 *
 * The tag is a due month, so a card whose due day falls on or before its
 * closing day closes in the month before the one it is tagged with. Callers
 * that have to place the closing day on a calendar go through here rather than
 * assuming the tag is the closing month.
 */
export function closingCycleOf(openCycle: string, closingDay: number, dueDay: number | null): string {
  if (dueDay !== null && dueDay <= closingDay) {
    return precedingCycle(openCycle);
  }
  return openCycle;
}

function precedingCycle(cycle: string): string {
  let year = Number(cycle.slice(0, 4));
  let month = Number(cycle.slice(5, 7)) - 1;
  if (month === 0) {
    year -= 1;
    month = 12;
  }
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
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

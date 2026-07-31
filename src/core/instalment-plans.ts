import type { Bill } from "./bill.ts";
import type { DerivedTransaction } from "./transaction.ts";
import {
  asGroup,
  bucketByInstant,
  debitRows,
  reconcileResiduals,
  segmentResiduals,
  type PlanGroup,
  type PlanRow,
} from "./instalment-grouping.ts";
import {
  adjustmentNotesOf,
  resolveOffsets,
  splitOffsets,
  type OffsetSplit,
} from "./instalment-reversals.ts";
import { comparePlans, purchaseDayOf } from "./instalment-presentation.ts";

/** Whether a money figure was published by the bank or projected from the instalments that were. */
export type FigureSource = "reported" | "estimated";

/** Whether the final cycle came from a placed row, a projection, or nothing at all. */
export type CycleSource = "reported" | "derived" | "unknown";

export type PlanStatus = "open" | "settled" | "reversed";

export type InstalmentPlan = {
  readonly accountId: string;
  readonly merchant: string;
  readonly purchaseDate: string | null;
  readonly purchaseTotalCents: number | null;
  readonly purchaseTotalSource: FigureSource | null;
  readonly instalmentAmountCents: number;
  readonly instalmentsPaid: number;
  readonly instalmentsTotal: number;
  readonly instalmentsRemaining: number;
  readonly remainingTotalCents: number;
  readonly remainingTotalSource: FigureSource;
  readonly finalCycle: string | null;
  readonly finalCycleSource: CycleSource;
  readonly status: PlanStatus;
  readonly renewal: boolean;
};

export type InstalmentPlanDerivation = {
  readonly plans: readonly InstalmentPlan[];
  /** Ambiguities the rules refuse to resolve silently. */
  readonly notes: readonly string[];
};

export type InstalmentPlanInput = {
  readonly rows: readonly DerivedTransaction[];
  readonly bills: readonly Bill[];
  /** The cycle currently accumulating, tagged by the month it falls due, or null when unidentifiable. */
  readonly openCycle: string | null;
  readonly today: string;
};

/** What the position and cycle rules need, resolved once per card. */
type CycleContext = {
  readonly cycleByBillId: ReadonlyMap<string, string>;
  readonly closedBillIds: ReadonlySet<string>;
  readonly openCycle: string | null;
};

/** A group with its positions already materialized, so no pass has to recompute them. */
type PlacedGroup = {
  readonly group: PlanGroup;
  readonly renewal: boolean;
  readonly positions: ReadonlyMap<number, PlanRow>;
};

type Money = { readonly cents: number; readonly source: FigureSource };

type PurchaseTotal = { readonly cents: number | null; readonly source: FigureSource | null };

type FinalCycle = { readonly finalCycle: string | null; readonly finalCycleSource: CycleSource };

/** How far a plan got, once reversed positions stop counting. */
type PlanProgress = { readonly status: PlanStatus; readonly instalmentsRemaining: number };

function cycleContext(input: InstalmentPlanInput): CycleContext {
  const cycleByBillId = new Map<string, string>();
  const closedBillIds = new Set<string>();
  for (const candidate of input.bills) {
    cycleByBillId.set(candidate.id, candidate.dueDate.slice(0, 7));
    if (billIsClosed(candidate, input.openCycle, input.today)) {
      closedBillIds.add(candidate.id);
    }
  }

  return { cycleByBillId, closedBillIds, openCycle: input.openCycle };
}

/**
 * A bill is closed when its cycle precedes the open one. Without an open cycle the closing date has
 * to answer, and a bill publishing neither counts as open, because the tool must never report a
 * smaller debt than the data supports.
 */
function billIsClosed(candidate: Bill, openCycle: string | null, today: string): boolean {
  if (openCycle !== null) {
    // Stryker disable next-line MethodExpression: `dueDate` is YYYY-MM-DD and `openCycle` is YYYY-MM, so the lexicographic comparison is decided by the shared seven-char prefix — the slice cannot change the result.
    return candidate.dueDate.slice(0, 7) < openCycle;
  }

  // Stryker disable next-line ConditionalExpression: the null guard is redundant — a null closingDate coerces to NaN and is already false in the `< today` comparison.
  return candidate.closingDate !== null && candidate.closingDate < today;
}

/** The cycle a row provably sits on, or null when nothing places it. */
function cycleOfRow(planRow: PlanRow, context: CycleContext): string | null {
  if (planRow.row.billId !== null) {
    return context.cycleByBillId.get(planRow.row.billId) ?? null;
  }
  // Stryker disable next-line ConditionalExpression: the openCycle null check is redundant — short-circuiting here and falling through to return the (null) openCycle produce the same null.
  if (context.openCycle === null || isFutureRow(planRow.row, context.openCycle)) {
    return null;
  }

  return context.openCycle;
}

/**
 * Mirrors `belongsToFutureCycle` in `bill-rows.ts`. Duplicated on purpose: this module stays
 * independent of that one until ticket 03 unifies the grouping, and ticket 03 owns the parity test.
 */
function isFutureRow(row: DerivedTransaction, openCycle: string): boolean {
  // Stryker disable all: the `billForecastDate !== null` guard is redundant — a null forecast coerces to NaN and is already false in the `> openCycle` comparison.
  return row.billForecastDate === "0001-01"
    || (row.billForecastDate !== null && row.billForecastDate > openCycle);
  // Stryker restore all
}

function paidPosition(byNumber: ReadonlyMap<number, PlanRow>, context: CycleContext): number {
  let paid = 0;
  for (const [number, planRow] of byNumber) {
    // Stryker disable next-line ConditionalExpression,EqualityOperator: the billId null guard is redundant (closedBillIds never holds null) and the position keys are distinct counters, so `>` and `>=` agree; the highest-counter test exercises the running maximum.
    if (planRow.row.billId !== null && context.closedBillIds.has(planRow.row.billId) && number > paid) {
      paid = number;
    }
  }

  return paid;
}

/** Advances a `YYYY-MM` cycle tag by whole months. */
function addMonths(cycle: string, months: number): string {
  const absolute = Number(cycle.slice(0, 4)) * 12 + (Number(cycle.slice(5, 7)) - 1) + months;
  const year = Math.trunc(absolute / 12);
  const month = (absolute % 12) + 1;

  // Stryker disable next-line StringLiteral: the year is always four digits, so padding to width four is a no-op whether the pad character is "0" or empty.
  return `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}`;
}

/** Projects from the highest-numbered instalment the data actually places on a cycle. */
function finalCycleOf(byNumber: ReadonlyMap<number, PlanRow>, total: number, context: CycleContext): FinalCycle {
  let anchorNumber = 0;
  let anchorCycle: string | null = null;
  for (const [number, planRow] of byNumber) {
    const cycle = cycleOfRow(planRow, context);
    // Stryker disable next-line EqualityOperator: the position map keys are distinct counters, so `>` and `>=` select the same anchor.
    if (cycle !== null && number > anchorNumber) {
      anchorNumber = number;
      anchorCycle = cycle;
    }
  }
  if (anchorCycle === null) {
    return { finalCycle: null, finalCycleSource: "unknown" };
  }
  if (anchorNumber === total) {
    return { finalCycle: anchorCycle, finalCycleSource: "reported" };
  }

  return { finalCycle: addMonths(anchorCycle, total - anchorNumber), finalCycleSource: "derived" };
}

/**
 * Reconstructs instalment purchases from a card's rows.
 *
 * `instalment-grouping.ts` decides which rows form a purchase, `instalment-reversals.ts` decides
 * which credits cancel one of its positions; everything here turns a purchase into cycles and money.
 */
export function deriveInstalmentPlans(input: InstalmentPlanInput): InstalmentPlanDerivation {
  const context = cycleContext(input);
  const { buckets, residual } = bucketByInstant(debitRows(input.rows));
  const reconciled = reconcileResiduals(buckets, residual);
  const segments = segmentResiduals(reconciled.residual);
  const placed: readonly PlacedGroup[] = [
    ...reconciled.buckets.map((group) => ({ group, renewal: false, positions: positionsOf(group) })),
    ...segments.map(({ group, renewal }) => ({ group, renewal, positions: positionsOf(group) })),
  ];
  const offsets = resolveOffsets({
    positions: placed.flatMap(({ positions }) => [...positions.values()]),
    rows: input.rows,
    cycleOf: (planRow) => cycleOfRow(planRow, context),
  });
  const plans = placed
    .map((group) => buildPlan(group, context, offsets.rowIds))
    .sort(comparePlans);
  const adjustmentNotes = placed.flatMap(({ positions }) => adjustmentNotesOf(positions, offsets.rowIds));

  return {
    plans,
    notes: [...reconciled.notes, ...offsets.notes, ...adjustmentNotes],
  };
}

function buildPlan(
  { group, renewal, positions }: PlacedGroup,
  context: CycleContext,
  offsetRowIds: ReadonlySet<string>,
): InstalmentPlan {
  const split = splitOffsets(positions, offsetRowIds);
  const total = group[0].total;
  const anchor = highestPosition(positions);
  const instalmentAmountCents = Math.abs(anchor.row.amountCents);
  const paid = paidPosition(split.active, context);
  const finalCycle = finalCycleOf(split.active, total, context);
  const remainingTotal = sumPositions(split, paid + 1, total, instalmentAmountCents);
  const purchaseTotal = purchaseTotalOf(split, total, instalmentAmountCents);
  const progress = planProgress(split, paid, total);

  return {
    accountId: anchor.row.accountId,
    merchant: anchor.row.descriptionNorm,
    purchaseDate: purchaseDayOf(group),
    purchaseTotalCents: purchaseTotal.cents,
    purchaseTotalSource: purchaseTotal.source,
    instalmentAmountCents,
    instalmentsPaid: paid,
    instalmentsTotal: total,
    instalmentsRemaining: progress.instalmentsRemaining,
    remainingTotalCents: remainingTotal.cents,
    remainingTotalSource: remainingTotal.source,
    finalCycle: finalCycle.finalCycle,
    finalCycleSource: finalCycle.finalCycleSource,
    status: progress.status,
    renewal,
  };
}

/** A plan whose every position was reversed owes nothing, whatever its counters say. */
function planProgress({ active, offsetNumbers }: OffsetSplit, paid: number, total: number): PlanProgress {
  if (active.size === 0) {
    return { status: "reversed", instalmentsRemaining: 0 };
  }
  const instalmentsRemaining = total - paid - offsetNumbers.size;
  if (paid === total) {
    return { status: "settled", instalmentsRemaining };
  }

  return { status: "open", instalmentsRemaining };
}

/** One row per counter. A duplicated counter keeps the oldest row, which is the posted one. */
function positionsOf(group: PlanGroup): ReadonlyMap<number, PlanRow> {
  const byNumber = new Map<number, PlanRow>();
  for (const planRow of group) {
    if (!byNumber.has(planRow.number)) {
      byNumber.set(planRow.number, planRow);
    }
  }

  return byNumber;
}

function highestPosition(byNumber: ReadonlyMap<number, PlanRow>): PlanRow {
  let highest: PlanRow | null = null;
  for (const planRow of byNumber.values()) {
    // Stryker disable next-line EqualityOperator: the position map keys are distinct counters, so `>` and `>=` select the same highest row.
    if (highest === null || planRow.number > highest.number) {
      highest = planRow;
    }
  }

  // Stryker disable next-line ConditionalExpression: callers pass a non-empty position map, so `highest` is always set and this guard always passes.
  if (highest !== null) {
    return highest;
  }
  // Stryker disable next-line ArrayDeclaration: unreachable — the map is non-empty, so the fallback never runs.
  return asGroup([])[0];
}

/** Sums positions in `[from, to]`, using the published amount wherever there is one. */
function sumPositions({ active, offsetNumbers }: OffsetSplit, from: number, to: number, instalmentAmountCents: number): Money {
  let cents = 0;
  let source: FigureSource = "reported";
  for (let position = from; position <= to; position += 1) {
    if (offsetNumbers.has(position)) {
      continue;
    }
    const planRow = active.get(position);
    if (planRow === undefined) {
      cents += instalmentAmountCents;
      source = "estimated";
      continue;
    }
    cents += Math.abs(planRow.row.amountCents);
  }

  return { cents, source };
}

/**
 * The full purchase cost. Both figures are `null` when the lowest observed counter is above 1: the
 * leading instalments were never cached and their amounts are not recoverable.
 */
function purchaseTotalOf(split: OffsetSplit, total: number, instalmentAmountCents: number): PurchaseTotal {
  if (split.active.size === 0) {
    return { cents: 0, source: "reported" };
  }
  if (lowestPositionNumber(split.active) !== 1 && !split.offsetNumbers.has(1)) {
    return { cents: null, source: null };
  }

  return sumPositions(split, 1, total, instalmentAmountCents);
}

/** The smallest counter the data placed. The group is non-empty, so the result is always finite. */
function lowestPositionNumber(byNumber: ReadonlyMap<number, PlanRow>): number {
  let lowest = Number.POSITIVE_INFINITY;
  for (const number of byNumber.keys()) {
    // Stryker disable next-line EqualityOperator: the position map keys are distinct counters, so `<` and `<=` select the same lowest row.
    if (number < lowest) {
      lowest = number;
    }
  }

  return lowest;
}

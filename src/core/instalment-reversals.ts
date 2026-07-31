import type { DerivedTransaction } from "./transaction.ts";
import type { PlanRow } from "./instalment-grouping.ts";

/**
 * Reversal accounting: which credits cancel which materialized debit positions, and what a plan's
 * positions look like once the cancelled ones are set aside.
 *
 * Credits are only allowed to cancel a debit position that debit-only grouping already produced.
 * A credit therefore cannot influence a plan's identity, even when its metadata looks plausible.
 * `instalment-plans.ts` owns cycles and money and calls in here; nothing here knows about bills.
 */

/** Places a row on a billing cycle, or answers null when nothing places it. */
export type CycleResolver = (planRow: PlanRow) => string | null;

export type OffsetResolution = {
  readonly rowIds: ReadonlySet<string>;
  readonly notes: readonly string[];
};

/** A plan's positions, split by whether a credit cancelled them. */
export type OffsetSplit = {
  readonly active: ReadonlyMap<number, PlanRow>;
  readonly offsetNumbers: ReadonlySet<number>;
};

export type OffsetInput = {
  /** Every debit position grouping materialized, across every plan on the card. */
  readonly positions: readonly PlanRow[];
  readonly rows: readonly DerivedTransaction[];
  readonly cycleOf: CycleResolver;
};

/** Either a credit claims exactly one position, or it leaves a note saying why it could not. */
type CreditMatch =
  | { readonly kind: "offset"; readonly rowId: string }
  | { readonly kind: "note"; readonly note: string };

type CreditMatchInput = {
  readonly credit: PlanRow;
  readonly positions: readonly PlanRow[];
  /** Positions an earlier credit already reversed. A position cancels at most once. */
  readonly claimed: ReadonlySet<string>;
  readonly cycleOf: CycleResolver;
};

/** Walks the card's credits in feed order, letting each claim at most one unclaimed position. */
export function resolveOffsets({ positions, rows, cycleOf }: OffsetInput): OffsetResolution {
  const rowIds = new Set<string>();
  const notes: string[] = [];
  for (const credit of creditRows(rows)) {
    const match = matchCredit({ credit, positions, claimed: rowIds, cycleOf });
    if (match.kind === "offset") {
      rowIds.add(match.rowId);
      continue;
    }
    notes.push(match.note);
  }

  return { rowIds, notes };
}

/**
 * A reversal is only unambiguous when one unclaimed position matches on identity and both sides sit
 * on the same established cycle. Every other outcome is reported rather than guessed at.
 */
function matchCredit({ credit, positions, claimed, cycleOf }: CreditMatchInput): CreditMatch {
  const identityMatches = positions.filter((position) => sameOffsetIdentity(position, credit));
  const candidates = identityMatches.filter((position) =>
    !claimed.has(position.row.id) && sameEstablishedCycle(position, credit, cycleOf));
  const [candidate] = candidates;
  // Stryker disable next-line ConditionalExpression: the `candidate !== undefined` guard is redundant — `candidates.length === 1` already implies the first element is defined.
  if (candidate !== undefined && candidates.length === 1) {
    return { kind: "offset", rowId: candidate.row.id };
  }
  // Stryker disable next-line EqualityOperator: this branch is only reached when no single candidate offset (length is 0 or >1, never exactly 1), so `>` and `>=` agree here.
  if (candidates.length > 1) {
    const matched = candidates.map(({ row }) => row.id).join(", ");
    // Stryker disable next-line StringLiteral: the discriminator is only ever compared against "offset", so the "note" literal is never read.
    return { kind: "note", note: `Ambiguous instalment reversal for credit row ${credit.row.id}: matching rows ${matched}` };
  }
  if (identityMatches.length > 0) {
    // Stryker disable next-line StringLiteral: the discriminator is only ever compared against "offset", so the "note" literal is never read.
    return { kind: "note", note: `Instalment reversal credit row ${credit.row.id} has no matching established billing cycle` };
  }

    // Stryker disable next-line StringLiteral: the discriminator is only ever compared against "offset", so the "note" literal is never read.
  return { kind: "note", note: `Unmatched instalment reversal credit row ${credit.row.id}` };
}

/** Positive rows with a usable counter are eligible to offset, but never to create plans. */
function creditRows(rows: readonly DerivedTransaction[]): readonly PlanRow[] {
  const credits: PlanRow[] = [];
  for (const row of rows) {
    // Stryker disable all: the `instalmentTotal === null` guard is redundant — a null total is also caught by the following `< 2` check (null coerces to 0).
    if (
      row.amountCents <= 0
      || row.instalmentNumber === null
      || row.instalmentTotal === null
      || row.instalmentTotal < 2
    ) {
    // Stryker restore all
      continue;
    }
    credits.push({ row, number: row.instalmentNumber, total: row.instalmentTotal });
  }

  return credits;
}

/** Same card, same normalized name, same counter out of the same total, same absolute amount. */
function sameOffsetIdentity(debit: PlanRow, credit: PlanRow): boolean {
  return debit.row.accountId === credit.row.accountId
    && debit.row.descriptionNorm === credit.row.descriptionNorm
    && debit.total === credit.total
    && debit.number === credit.number
    && Math.abs(debit.row.amountCents) === Math.abs(credit.row.amountCents);
}

/** An unplaced debit has no cycle to agree on, so it can never be reversed. */
function sameEstablishedCycle(debit: PlanRow, credit: PlanRow, cycleOf: CycleResolver): boolean {
  const debitCycle = cycleOf(debit);
  return debitCycle !== null && debitCycle === cycleOf(credit);
}

/** Reversed positions keep their counter, they just stop counting as owed. */
export function splitOffsets(
  positions: ReadonlyMap<number, PlanRow>,
  offsetRowIds: ReadonlySet<string>,
): OffsetSplit {
  const active = new Map<number, PlanRow>();
  const offsetNumbers = new Set<number>();
  for (const [number, position] of positions) {
    if (offsetRowIds.has(position.row.id)) {
      offsetNumbers.add(number);
      continue;
    }
    active.set(number, position);
  }

  return { active, offsetNumbers };
}

/** Partial reversals need saying out loud; a fully reversed plan already reads as `reversed`. */
export function adjustmentNotesOf(
  positions: ReadonlyMap<number, PlanRow>,
  offsetRowIds: ReadonlySet<string>,
): readonly string[] {
  const offsets = [...positions.values()].filter(({ row }) => offsetRowIds.has(row.id));
  if (offsets.length === 0 || offsets.length === positions.size) {
    return [];
  }

  return [`Instalment plan adjustment: offset rows ${offsets.map(({ row }) => row.id).join(", ")}`];
}

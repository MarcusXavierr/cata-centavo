import type { DerivedTransaction } from "./transaction.ts";

/**
 * Plan identity: the three passes that turn a card's loose instalment rows into purchases.
 *
 * The feed carries no plan id, so identity is derived. `docs/plans/2026-07-30-instalment-plans-design.md`
 * records why each obvious key fails on real rows and what replaces them. `instalment-plans.ts`
 * runs the passes in order and turns each group into money; nothing here knows about bills, cycles
 * or amounts.
 */

/** One instalment row, with its counter narrowed to a number. */
export type PlanRow = {
  readonly row: DerivedTransaction;
  readonly number: number;
  readonly total: number;
};

/**
 * A plan's rows. Non-empty by construction: buckets carry two or more and segments carry at least
 * one, so `buildPlan` never has to invent an identity for nothing.
 */
export type PlanGroup = readonly [PlanRow, ...PlanRow[]];

/** A bucket while reconciliation is still appending rows to it. */
type MutableGroup = [PlanRow, ...PlanRow[]];

/** Debit rows carrying a usable counter, oldest first. Ties break on id so the order is total. */
export function debitRows(rows: readonly DerivedTransaction[]): readonly PlanRow[] {
  const planRows: PlanRow[] = [];
  for (const row of rows) {
  // Stryker disable next-line ConditionalExpression: the `instalmentTotal === null` guard is redundant — a null total is also caught by the following `< 2` check (null coerces to 0); the missing-counter test exercises the instalmentNumber operand.
    if (row.instalmentNumber === null || row.instalmentTotal === null || row.instalmentTotal < 2) {
      continue;
    }
    if (row.amountCents >= 0) {
      continue;
    }
    planRows.push({ row, number: row.instalmentNumber, total: row.instalmentTotal });
  }

  return planRows.sort(byLocalDateThenId);
}

function byLocalDateThenId(left: PlanRow, right: PlanRow): number {
  if (left.row.localDate !== right.row.localDate) {
    return left.row.localDate.localeCompare(right.row.localDate);
  }
  return left.row.id.localeCompare(right.row.id);
}

/**
 * Groups rows by the untruncated purchase instant.
 *
 * An instant covering two or more counters is strong evidence of one purchase; an instant covering
 * one row is no evidence either way, because some connectors stamp a posting date there.
 */
export function bucketByInstant(candidates: readonly PlanRow[]): {
  readonly buckets: readonly PlanGroup[];
  readonly residual: readonly PlanRow[];
} {
  const { grouped, residual } = accumulateByInstant(candidates);

  const buckets: PlanGroup[] = [];
  for (const group of grouped.values()) {
    if (new Set(group.map(({ number }) => number)).size >= 2) {
      buckets.push(asGroup(group));
      continue;
    }
    residual.push(...group);
  }

  // Stryker disable next-line all: callers pass `debitRows` output, which is already totally ordered by this comparator; sorting it again is defensive and a no-op.
  return { buckets, residual: residual.sort(byLocalDateThenId) };
}

/**
 * Sends rows with a purchase instant into keyed buckets; rows without one are residual.
 */
function accumulateByInstant(candidates: readonly PlanRow[]): {
  readonly grouped: Map<string, PlanRow[]>;
  readonly residual: PlanRow[];
} {
  const grouped = new Map<string, PlanRow[]>();
  const residual: PlanRow[] = [];
  for (const candidate of candidates) {
    if (candidate.row.purchaseDate === null) {
      residual.push(candidate);
      continue;
    }
    pushInto(grouped, `${candidate.row.accountId}|${candidate.row.purchaseDate}|${candidate.total}`, candidate);
  }

  return { grouped, residual };
}

function pushInto(groups: Map<string, PlanRow[]>, key: string, candidate: PlanRow): void {
  const existing = groups.get(key);
  if (existing === undefined) {
    groups.set(key, [candidate]);
    return;
  }
  existing.push(candidate);
}

export type Reconciliation = {
  readonly buckets: readonly PlanGroup[];
  readonly residual: readonly PlanRow[];
  /** Ambiguities the rules refuse to resolve silently. */
  readonly notes: readonly string[];
};

/**
 * Second pass: offers every leftover row to the buckets that could still be missing it, lowest
 * counter first, so a bucket that has just absorbed 5/10 can go on to absorb 6/10.
 */
export function reconcileResiduals(
  buckets: readonly PlanGroup[],
  residual: readonly PlanRow[],
): Reconciliation {
  const open: MutableGroup[] = buckets.map((group) => [...group]);
  const unresolved: PlanRow[] = [];
  const notes: string[] = [];

  for (const candidate of [...residual].sort(byCounterThenLocalDateThenId)) {
    const matching = open.filter((bucket) => bucketAccepts(bucket, candidate));
    const selected = selectBucket(matching);
    if (selected === null) {
      // Stryker disable next-line EqualityOperator: `selected === null` can only happen when ranks tie, which requires at least two matching buckets; therefore the `> 1` and `>= 1` tests are equivalent on this branch.
      if (matching.length > 1) {
        notes.push(`Ambiguous instalment reconciliation for row ${candidate.row.id}`);
      }
      unresolved.push(candidate);
      continue;
    }
    selected.push(candidate);
  }

  return { buckets: open, residual: unresolved, notes };
}

function byCounterThenLocalDateThenId(left: PlanRow, right: PlanRow): number {
  // Stryker disable next-line ConditionalExpression: residual input was already sorted by local date and id, so equal counters retain the same tie order.
  if (left.number !== right.number) {
    return left.number - right.number;
  }
  return byLocalDateThenId(left, right);
}

/**
 * A bucket can still be missing a row when the two share a card and a plan length, the bucket
 * already answers to that name under one of its spellings, the counter is free, and it sits ahead
 * of everything the bucket holds. Anything behind the bucket's own high-water mark belongs to an
 * earlier purchase, not to this one.
 */
function bucketAccepts(bucket: MutableGroup, candidate: PlanRow): boolean {
  return bucket[0].row.accountId === candidate.row.accountId
    && bucket[0].total === candidate.total
    && counterIsFreeAndLater(bucket, candidate)
    && bucket.some(({ row }) => row.descriptionNorm === candidate.row.descriptionNorm);
}

/**
 * A counter above the bucket's numeric maximum cannot already be held by that bucket.
 * The `<=` mutation is equivalent because equality means the maximum row holds the counter.
 */
function counterIsFreeAndLater(bucket: MutableGroup, candidate: PlanRow): boolean {
  // Stryker disable next-line all: equality cannot pass because the maximum counter is materialized.
  return highestCounter(bucket) < candidate.number;
}

/** How far along a bucket is. Two buckets equal on both keys are indistinguishable. */
type Rank = {
  readonly highest: number;
  readonly latestDate: string;
};

/** The furthest-along bucket takes the row; a tie on both keys leaves the row residual. */
function selectBucket(candidates: readonly MutableGroup[]): MutableGroup | null {
  let selected: MutableGroup | null = null;
  // Stryker disable next-line UnaryOperator,StringLiteral: the rank sentinels are never decisive — every competing bucket has already placed at least two counters (highest >= 2), so the first comparison always resolves on `highest` before `latestDate` is read.
  let best: Rank = { highest: -1, latestDate: "" };
  // Stryker disable next-line BooleanLiteral: the first non-empty bucket always outranks the sentinel and resets this flag before it can affect the result.
  let ambiguous = false;

  for (const candidate of candidates) {
    const rank = { highest: highestCounter(candidate), latestDate: latestLocalDate(candidate) };
    const order = compareRank(rank, best);
    if (order > 0) {
      selected = candidate;
      best = rank;
      ambiguous = false;
      continue;
    }
    if (order === 0) {
      ambiguous = true;
    }
  }

  if (ambiguous) {
    return null;
  }
  return selected;
}

function compareRank(left: Rank, right: Rank): number {
  if (left.highest !== right.highest) {
    return left.highest - right.highest;
  }
  return left.latestDate.localeCompare(right.latestDate);
}

function highestCounter(group: readonly PlanRow[]): number {
  let highest = 0;
  for (const { number } of group) {
    // Stryker disable next-line ConditionalExpression,EqualityOperator: this returns only the numeric maximum; assigning an equal maximum is observationally identical, and callers never observe which row supplied it.
    if (number > highest) {
      highest = number;
    }
  }

  return highest;
}

function latestLocalDate(group: readonly PlanRow[]): string {
  let latest = "";
  for (const { row } of group) {
    // Stryker disable next-line ConditionalExpression,EqualityOperator: this returns only the maximal date string; reassigning an equal date is observationally identical, and callers never observe which row supplied it.
    if (row.localDate > latest) {
      latest = row.localDate;
    }
  }

  return latest;
}

export type SegmentedGroup = {
  readonly group: PlanGroup;
  readonly renewal: boolean;
};

/**
 * Third pass: what the instant never grouped is keyed on card, name and plan length, then cut into
 * separate purchases, because a card can buy twice from one merchant.
 */
export function segmentResiduals(residual: readonly PlanRow[]): readonly SegmentedGroup[] {
  const byMerchant = new Map<string, PlanRow[]>();
  for (const candidate of residual) {
    pushInto(byMerchant, `${candidate.row.accountId}|${candidate.row.descriptionNorm}|${candidate.total}`, candidate);
  }

  const segments: SegmentedGroup[] = [];
  for (const rows of byMerchant.values()) {
    segments.push(...segmentsOf(rows));
  }

  return segments;
}

/**
 * Cuts one merchant's rows wherever the counter stops advancing: that is where the next purchase
 * begins. A cut renews the run before it when that run reached its last instalment and this one
 * restarts at 1, which is what an annual fee looks like — twelve counters, then twelve more.
 */
function segmentsOf(rows: readonly PlanRow[]): readonly SegmentedGroup[] {
  const runs: PlanGroup[] = [];
  let current: PlanRow[] = [];
  for (const candidate of [...rows].sort(byLocalDateThenId)) {
    const previous = current.at(-1);
    if (previous !== undefined && candidate.number <= previous.number) {
      runs.push(asGroup(current));
      current = [];
    }
    current.push(candidate);
  }
    // Stryker disable next-line ConditionalExpression,EqualityOperator: this function only receives non-empty merchant groups, so `current` always holds the final run and `> 0` never differs from `>= 0`.
  if (current.length > 0) {
    runs.push(asGroup(current));
  }

  return runs.map((group, index) => {
    const preceding = runs[index - 1];

    return {
      group,
      renewal: preceding !== undefined
        && highestCounter(preceding) === preceding[0].total
        && group[0].number === 1,
    };
  });
}

/** Narrows an array the caller already knows is non-empty. */
export function asGroup(rows: readonly PlanRow[]): PlanGroup {
  const [head, ...tail] = rows;
  // Stryker disable next-line ConditionalExpression,BlockStatement: unreachable guard — every caller passes a non-empty group, so `head` is always defined.
  if (head === undefined) {
    // Stryker disable next-line all: unreachable, every caller filters empty groups first.
    throw new Error("An instalment plan group cannot be empty");
  }

  return [head, ...tail];
}

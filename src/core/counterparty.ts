import type { CategoryId } from "./category.ts";
import { isCategoryId } from "./category.ts";



/**
 * A document we accept from a human. Both lengths are usable manually; only a
 * CNPJ is ever learned from data (design D4).
 */
export function isDocument(value: string): boolean {
  return value.length === 11 || value.length === 14;
}

export function isCnpj(value: string): boolean {
  return value.length === 14;
}

export type LabelledRow = {
  readonly document: string | null;
  readonly category: string | null;
};

export type LearnedCounterparty = {
  readonly document: string;
  readonly category: CategoryId;
  readonly samples: number;
  readonly agreeing: number;
};

/**
 * A document's category, when its rows agree by a true majority.
 *
 * A plurality is not enough. `mcc.ts` maps by plurality and says so, but an MCC
 * is a line of business shared by thousands of merchants, while a CNPJ is one
 * merchant — a 12-of-25 CNPJ mapping is a coin flip applied retroactively to
 * everything that merchant ever sold you.
 */
export function learnCounterparties(rows: readonly LabelledRow[]): readonly LearnedCounterparty[] {
  const result: LearnedCounterparty[] = [];

  for (const [document, counts] of tally(rows)) {
    const winner = majorityOf(document, counts);
    if (winner !== null) {
      result.push(winner);
    }
  }

  return result;
}

type CategoryCounts = Map<CategoryId, number>;

/** How many rows each CNPJ carries per category. Anything else is dropped here. */
function tally(rows: readonly LabelledRow[]): ReadonlyMap<string, CategoryCounts> {
  const byDocument = new Map<string, CategoryCounts>();

  for (const row of rows) {
    if (!isLearnable(row)) {
      continue;
    }

    let counts = byDocument.get(row.document);
    if (counts === undefined) {
      counts = new Map();
      byDocument.set(row.document, counts);
    }
    counts.set(row.category, (counts.get(row.category) ?? 0) + 1);
  }

  return byDocument;
}

/** Narrows to a row we are willing to learn from: a CNPJ carrying a known category. */
// Stryker disable next-line ConditionalExpression: the null checks are defensive. The caller's SQL already filters `document IS NOT NULL`, and this function is public enough that a second caller should not have to know that.
function isLearnable(row: LabelledRow): row is { readonly document: string; readonly category: CategoryId } {
  return row.document !== null && isCnpj(row.document) && row.category !== null && isCategoryId(row.category);
}

/** The category holding a true majority of a document's rows, or nothing. */
function majorityOf(document: string, counts: CategoryCounts): LearnedCounterparty | null {
  let samples = 0;
  let agreeing = 0;
  let category: CategoryId | null = null;

  for (const [candidate, count] of counts) {
    samples += count;
    // Stryker disable next-line EqualityOperator: `>=` only changes which of two tied categories wins, and a tie can never clear the majority test below — both would be dropped either way.
    if (count > agreeing) {
      agreeing = count;
      category = candidate;
    }
  }

  if (category === null || agreeing * 2 <= samples) {
    return null;
  }
  return { document, category, samples, agreeing };
}

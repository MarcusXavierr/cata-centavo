import type { UnavailableConnection } from "./accounts.ts";
import type { Bank, BankFailure } from "./contracts.ts";
import type { InvestmentPosition } from "./investment.ts";

/** Positions collected across selected connections and any failed requests. */
export type CollectedInvestments = {
  readonly positions: readonly InvestmentPosition[];
  readonly unavailable: readonly UnavailableConnection[];
};

/** Totals grouped by currency without converting between currencies. */
export type InvestmentSummary = {
  readonly currency: string;
  readonly balanceCents: number;
};

type InvestmentSortKey = Pick<InvestmentPosition, "currency" | "balanceCents" | "institution" | "name" | "id">;

/** Collects active positions concurrently, preserving partial successful data. */
export async function collectInvestments(
  bank: Bank,
  connectionIds: readonly string[],
  toFailure: (error: unknown) => BankFailure,
): Promise<CollectedInvestments> {
  const requests = connectionIds.map((connectionId) => ({ connectionId, investments: bank.getInvestments(connectionId) }));
  const settled = await Promise.allSettled(requests.map(({ investments }) => investments));
  const positions: InvestmentPosition[] = [];
  const unavailable: UnavailableConnection[] = [];

  for (const [index, result] of settled.entries()) {
    const connectionId = requests[index]!.connectionId;
    if (result.status === "rejected") {
      unavailable.push({ connectionId, ...toFailure(result.reason) });
      continue;
    }
    positions.push(...result.value);
  }

  return { positions, unavailable };
}

function compareText(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

/** Orders positions by the stable portfolio cursor tuple. */
export function compareInvestmentPositions(left: InvestmentSortKey, right: InvestmentSortKey): number {
  const currency = compareText(left.currency, right.currency);
  if (currency !== 0) {
    return currency;
  }

  if (left.balanceCents !== right.balanceCents) {
    if (left.balanceCents > right.balanceCents) {
      return -1;
    }
    return 1;
  }

  const institution = compareText(left.institution, right.institution);
  if (institution !== 0) {
    return institution;
  }

  const name = compareText(left.name, right.name);
  if (name !== 0) {
    return name;
  }

  return compareText(left.id, right.id);
}

/** Returns positions sorted without mutating the caller's array. */
export function sortInvestments(positions: readonly InvestmentPosition[]): InvestmentPosition[] {
  return [...positions].sort(compareInvestmentPositions);
}

/** Sums integer-cent balances by currency, returning currencies ascending. */
export function summarizeInvestments(positions: readonly InvestmentPosition[]): readonly InvestmentSummary[] {
  const totals = new Map<string, number>();
  for (const position of positions) {
    totals.set(position.currency, (totals.get(position.currency) ?? 0) + position.balanceCents);
  }

  return [...totals.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([currency, balanceCents]) => ({ currency, balanceCents }));
}

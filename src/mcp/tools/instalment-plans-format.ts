import type { Account } from "../../core/account.ts";
import type { InstalmentPlan, InstalmentPlanDerivation } from "../../core/instalment-plans.ts";
import type { TransactionReader, LoadResult } from "../../core/transactions.ts";
import { toDecimal } from "../format.ts";
import { formatSummaryBase } from "./bill-summary-format.ts";

/** A card's derivation retained with its identity for wire serialization. */
export type CardPlans = {
  readonly account: Account;
  readonly derivation: InstalmentPlanDerivation;
  readonly openCycle: string | null;
};

type ResponseOptions = {
  readonly derivations: readonly CardPlans[];
  readonly includeSettled: boolean;
  readonly accountIds: readonly string[];
  readonly reader: TransactionReader;
  readonly today: string;
  readonly unavailable: LoadResult["unavailable"];
  readonly connectionId: string | undefined;
  readonly connectionIds: readonly string[];
};

/** Converts derived plans and freshness metadata into the MCP response payload. */
export function serializeResponse(options: ResponseOptions): Readonly<Record<string, unknown>> {
  const allPlans = options.derivations.flatMap(({ derivation }) => derivation.plans);
  const plans = options.derivations.flatMap(({ account, derivation }) =>
    derivation.plans
      .filter((plan) => options.includeSettled || plan.status === "open")
      .map((plan) => serializePlan(account, plan)),
  );
  const openPlans = allPlans.filter((plan) => plan.status === "open");
  const notes = options.derivations.flatMap(({ account, derivation, openCycle }) =>
    notesForCard(account, derivation, openCycle),
  );
  const notice = unavailableNotice(options.unavailable, options.connectionId, options.connectionIds);

  return {
    plans,
    totals: {
      planCount: openPlans.length,
      remaining: toDecimal(openPlans.reduce((total, plan) => total + plan.remainingTotalCents, 0)),
    },
    notes,
    dataThrough: [...options.reader.dataThrough(options.accountIds, options.today)]
      .map(([connectionId, through]) => ({ connectionId, through })),
    unavailable: options.unavailable,
    notice,
  };
}

function notesForCard(
  account: Account,
  derivation: InstalmentPlanDerivation,
  openCycle: string | null,
): readonly string[] {
  const notes = [...derivation.notes];
  if (openCycle === null) {
    notes.push(`${account.name}: no closing day stored for this card; call setClosingDay to get final cycles`);
  }
  return notes;
}

function serializePlan(account: Account, plan: InstalmentPlan): Readonly<Record<string, unknown>> {
  let purchaseTotal: string | null = null;
  if (plan.purchaseTotalCents !== null) {
    purchaseTotal = toDecimal(plan.purchaseTotalCents);
  }
  return {
    card: account.name,
    ...formatSummaryBase(account),
    merchant: plan.merchant,
    purchaseDate: plan.purchaseDate,
    purchaseTotal,
    purchaseTotalSource: plan.purchaseTotalSource,
    instalmentAmount: toDecimal(plan.instalmentAmountCents),
    instalmentsPaid: plan.instalmentsPaid,
    instalmentsTotal: plan.instalmentsTotal,
    instalmentsRemaining: plan.instalmentsRemaining,
    remainingTotal: toDecimal(plan.remainingTotalCents),
    remainingTotalSource: plan.remainingTotalSource,
    finalCycle: plan.finalCycle,
    finalCycleSource: plan.finalCycleSource,
    status: plan.status,
    renewal: plan.renewal,
  };
}

function unavailableNotice(
  unavailable: LoadResult["unavailable"],
  connectionId: string | undefined,
  connectionIds: readonly string[],
): string | undefined {
  if (unavailable.length > 0) {
    return `Some connections were unavailable: ${unavailable.map((entry) => entry.connectionId).join(", ")}.`;
  }
  if (connectionId !== undefined && connectionIds.length === 0) {
    return `Connection ${connectionId} is unavailable or not configured.`;
  }
  return undefined;
}

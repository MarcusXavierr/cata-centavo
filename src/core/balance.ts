import type { Account } from "./account.ts";

export type Summary = {
  readonly cashCents: number;
  readonly creditUsedCents: number;
  readonly investedCents?: number;
  readonly loanCents?: number;
  readonly currency: string;
  readonly accountsCounted: number;
};

export type SummaryResult =
  | { readonly ok: true; readonly summary: Summary }
  | { readonly ok: false; readonly currencies: readonly string[] };

type Totals = {
  cashCents: number;
  creditUsedCents: number;
  investedCents: number;
  loanCents: number;
  hasInvestments: boolean;
  hasLoans: boolean;
};

function currenciesIn(accounts: readonly Account[]): readonly string[] {
  return [...new Set(accounts.map((account) => account.currency))].sort();
}

function sumBalances(accounts: readonly Account[]): Totals {
  const totals: Totals = {
    cashCents: 0,
    creditUsedCents: 0,
    investedCents: 0,
    loanCents: 0,
    hasInvestments: false,
    hasLoans: false,
  };

  for (const account of accounts) {
    switch (account.type) {
      case "BANK":
        totals.cashCents += account.amountCents;
        break;
      case "CREDIT":
        totals.creditUsedCents += account.amountCents;
        break;
      case "INVESTMENT":
        totals.investedCents += account.amountCents;
        totals.hasInvestments = true;
        break;
      case "LOAN":
        totals.loanCents += account.amountCents;
        totals.hasLoans = true;
        break;
    }
  }

  return totals;
}

function createSummary(currency: string, accountsCounted: number, totals: Totals): Summary {
  return {
    cashCents: totals.cashCents,
    creditUsedCents: totals.creditUsedCents,
    currency,
    accountsCounted,
    ...(totals.hasInvestments ? { investedCents: totals.investedCents } : {}),
    ...(totals.hasLoans ? { loanCents: totals.loanCents } : {}),
  };
}

export function summarize(accounts: readonly Account[]): SummaryResult {
  const currencies = currenciesIn(accounts);

  if (currencies.length !== 1) {
    return { ok: false, currencies };
  }

  const currency = currencies[0];
  if (currency === undefined) {
    return { ok: false, currencies };
  }

  return { ok: true, summary: createSummary(currency, accounts.length, sumBalances(accounts)) };
}

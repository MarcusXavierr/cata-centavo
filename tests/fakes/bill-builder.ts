import type { Account } from "../../src/core/account.ts";
import type { Bill } from "../../src/core/bill.ts";
import type { DerivedTransaction } from "../../src/core/transaction.ts";
import { account } from "./fake-bank.ts";
import { fixedClock } from "./fixed-clock.ts";
import type { FixedClock } from "./fixed-clock.ts";

const DEFAULT_TODAY = "2026-07-26";
const DEFAULT_BALANCE_DUE_DATE = "2026-07-15";

export type BillFixture = {
  readonly accountId: string;
  readonly account: Account;
  readonly bills: readonly Bill[];
  readonly rows: readonly DerivedTransaction[];
  readonly storedDay: number | null;
  readonly balanceDueDate: string | null;
  readonly utilizationCents: number;
  readonly today: string;
  readonly clock: FixedClock;
};

/** Builds a complete synthetic credit-card bill, with overrides for focused cases. */
export function bill(overrides: Partial<Bill> = {}): Bill {
  return {
    id: "bill-1",
    closingDate: "2026-07-08",
    dueDate: "2026-07-15",
    totalCents: 10_000,
    currency: "BRL",
    minimumPaymentCents: 1_000,
    financeChargesCents: 0,
    paymentsCents: 0,
    paymentCount: 0,
    ...overrides,
  };
}

/** One card's whole world: account, bills, rows, stored closing day, and clock. */
export function billFixture(overrides: Partial<BillFixture> = {}): BillFixture {
  let balanceDueDate: string | null = DEFAULT_BALANCE_DUE_DATE;
  if (overrides.balanceDueDate !== undefined) {
    balanceDueDate = overrides.balanceDueDate;
  }
  const today = overrides.today ?? DEFAULT_TODAY;
  const accountId = overrides.accountId ?? "card-1";
  const utilizationCents = overrides.utilizationCents ?? 10_000;
  const defaultAccount = account(accountId, {
    type: "CREDIT",
    subtype: "CREDIT_CARD",
    amountCents: utilizationCents,
    credit: {
      limitCents: 100_000,
      availableLimitCents: 90_000,
      balanceCloseDate: null,
      balanceDueDate: dateOrNull(balanceDueDate),
      brand: "Synthetic",
    },
  });

  return {
    accountId,
    account: overrides.account ?? defaultAccount,
    bills: overrides.bills ?? [],
    rows: overrides.rows ?? [],
    storedDay: overrides.storedDay ?? null,
    balanceDueDate,
    utilizationCents,
    today,
    clock: overrides.clock ?? fixedClock(new Date(`${today}T12:00:00.000Z`)),
  };
}

function dateOrNull(value: string | null): Date | null {
  if (value === null) {
    return null;
  }

  return new Date(`${value}T03:00:00.000Z`);
}

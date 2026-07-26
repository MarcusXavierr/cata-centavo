/**
 * An account as we speak of it, which is not as Pluggy speaks of it (ADR §14.1).
 * `type` is a superset of Pluggy's `BANK | CREDIT` because investments and loans
 * are representable under neither; `pluggy/mapper.ts` owns the widening.
 */
export const ACCOUNT_TYPES = {
  bank: "BANK",
  credit: "CREDIT",
  investment: "INVESTMENT",
  loan: "LOAN",
} as const;

export type AccountType = (typeof ACCOUNT_TYPES)[keyof typeof ACCOUNT_TYPES];

export type Account = {
  readonly id: string;
  readonly connectionId: string;
  readonly institution: string;
  readonly name: string;
  readonly type: AccountType;
  readonly subtype: string | null;
  /**
   * Money in the account, in cents. On BANK this is available funds. On CREDIT
   * from an Open Finance connector it is the used credit limit at request time,
   * neither the closed bill nor the open one.
   */
  readonly amountCents: number;
  readonly currency: string;
  /** Of the connection, not the account — Pluggy carries it on the item. */
  readonly lastUpdatedAt: Date | null;
  /** Populated only on `type: "CREDIT"`. */
  readonly credit: CreditDetails | null;
};

export type CreditDetails = {
  readonly limitCents: number | null;
  readonly availableLimitCents: number | null;
  readonly balanceCloseDate: Date | null;
  readonly balanceDueDate: Date | null;
  readonly brand: string | null;
};

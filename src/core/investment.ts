
/** A provider-independent active investment position. */
export type InvestmentPosition = {
  readonly id: string;
  readonly connectionId: string;
  readonly institution: string;
  readonly name: string;
  readonly type: string;
  readonly subtype: string | null;
  readonly balanceCents: number;
  readonly currency: string;
  readonly quantity: string | null;
};


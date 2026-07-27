import type { AccountType } from "./account.ts";
import type { ResolvedCategory } from "./category-source.ts";


/**
 * A transaction as we speak of it, which is not as Pluggy speaks of it (ADR §14.0).
 *
 * Two fields carry corrections that cost real money if reversed, both recorded
 * in `docs/plans/2026-07-26-phase-2-transactions-design.md`:
 *
 * - `amountCents` is normalized: negative is money out on every account type.
 * - `currency` is the account's currency, the unit `amountCents` is denominated
 *   in, never the purchase's original currency.
 *
 * The detail fields are extracted at map time rather than kept as raw Pluggy
 * blobs, so SQL can use them in later derivation rules and the MCP boundary can
 * expose our vocabulary.
 */
export type Transaction = {
  readonly id: string;
  readonly accountId: string;
  readonly connectionId: string;
  readonly accountType: AccountType;
  readonly accountSubtype: string | null;
  /** The instant as reported, untruncated. */
  readonly occurredAt: string;
  /** The calendar day in `America/Sao_Paulo`, `YYYY-MM-DD`. What ranges filter on. */
  readonly localDate: string;
  readonly amountCents: number;
  readonly currency: string;
  /** Populated only when the purchase was made in another currency. */
  readonly originalAmountCents: number | null;
  readonly originalCurrency: string | null;
  readonly description: string;
  readonly descriptionNorm: string;
  /** The leaf id Pluggy reported, unrolled. The group is derived at read time. */
  readonly categoryId: string | null;
  /** Counterparty CPF/CNPJ, digits only (ADR §12.2). Absent on cards. */
  readonly document: string | null;
  readonly counterpartyName: string | null;
  readonly paymentMethod: string | null;
  /** Absent on bank rows. */
  readonly mcc: string | null;
  readonly billId: string | null;
  readonly instalmentNumber: number | null;
  readonly instalmentTotal: number | null;
  readonly purchaseDate: string | null;
};

/** A cached transaction plus the category the derivation resolved for it. */
export type DerivedTransaction = Transaction & ResolvedCategory;


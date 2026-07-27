import { ACCOUNT_TYPES, type Account, type CreditDetails } from "../core/account.ts";
import type { Bill } from "../core/bill.ts";
import type { Connection, Consent } from "../core/contracts.ts";
import { ResponseShapeError } from "./errors.ts";
import { toCents } from "./money.ts";
import type { WireAccount, WireBill, WireConsent, WireItem } from "./wire.ts";

export { toCents } from "./money.ts";
export { toTransaction } from "./transaction-mapper.ts";

/**
 * Where Pluggy's vocabulary stops and ours begins (ADR §14.0). An *item* is a
 * connection, and no domain type past this file mentions the other word.
 *
 * This is also the only place that knows dates arrive as strings, since we
 * parse the raw body rather than going through the SDK's date reviver.
 */
export function toConnection(item: WireItem): Connection {
  let lastUpdatedAt: Date | null;
  if (item.lastUpdatedAt === null) {
    lastUpdatedAt = null;
  } else {
    lastUpdatedAt = new Date(item.lastUpdatedAt);
  }

  return {
    id: item.id,
    institution: item.connector.name,
    status: item.status,
    executionStatus: item.executionStatus ?? null,
    lastUpdatedAt,
    parameter: item.parameter?.label ?? null,
    warnings: toWarnings(item.statusDetail),
    failedLogins: item.consecutiveFailedLoginAttempts ?? null,
  };
}

/** The consent's own `itemId` never reaches this function; see `wire.ts`. */
export function toConsent(consent: WireConsent): Consent {
  return {
    expiresAt: toNullableDate(consent.expiresAt),
    revokedAt: toNullableDate(consent.revokedAt),
    products: consent.products ?? [],
  };
}

function toNullableDate(value: string | null | undefined): Date | null {
  if (value === null || value === undefined) {
    return null;
  }
  return new Date(value);
}

/** Maps Pluggy's account vocabulary and raw monetary values onto our domain. */
export function toAccount(account: WireAccount, connection: Connection): Account {
  let credit: CreditDetails | null;
  if (account.type === ACCOUNT_TYPES.credit) {
    credit = toCreditDetails(account.creditData);
  } else {
    credit = null;
  }

  return {
    id: account.id,
    connectionId: connection.id,
    institution: connection.institution,
    name: account.marketingName ?? account.name,
    type: toAccountType(account.type),
    subtype: account.subtype ?? null,
    amountCents: toCents(account.balance),
    currency: account.currencyCode,
    lastUpdatedAt: connection.lastUpdatedAt,
    credit,
  };
}

/** Maps Pluggy's bill body onto our statement vocabulary. */
export function toBill(bill: WireBill, account: Account): Bill {
  return {
    id: bill.id,
    closingDate: utcDayOrNull(bill.billClosingDate),
    dueDate: utcDayOf(bill.dueDate),
    totalCents: toCents(bill.totalAmount),
    currency: bill.totalAmountCurrencyCode ?? account.currency,
    minimumPaymentCents: toNullableCents(bill.minimumPaymentAmount),
    financeChargesCents: sumAmounts(bill.financeCharges),
    paymentsCents: sumAmounts(bill.payments),
    paymentCount: bill.payments.length,
  };
}

function utcDayOrNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return utcDayOf(value);
}

function utcDayOf(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new ResponseShapeError(`Pluggy returned an invalid bill date: ${value}`);
  }

  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function sumAmounts(rows: readonly { readonly amount: number }[]): number {
  return rows.reduce((sum, row) => sum + toCents(row.amount), 0);
}

function toAccountType(type: string): Account["type"] {
  if (type === ACCOUNT_TYPES.bank || type === ACCOUNT_TYPES.credit) {
    return type;
  }

  throw new ResponseShapeError(`Pluggy returned an unrecognised account type: ${type}`);
}

/**
 * Selects the limit the cardholder actually has. Pluggy's available amount can
 * be based on a customized limit rather than the bank's headline limit.
 */
function toLimitCents(creditData: NonNullable<WireAccount["creditData"]>): number | null {
  const total = creditData.disaggregatedCreditLimits?.find(
    (line) => line.creditLineLimitType === "LIMITE_CREDITO_TOTAL",
  );

  return toNullableCents(total?.customizedLimitAmount ?? creditData.creditLimit);
}

function toCreditDetails(creditData: WireAccount["creditData"]): CreditDetails | null {
  if (creditData === null || creditData === undefined) {
    return null;
  }

  return {
    limitCents: toLimitCents(creditData),
    availableLimitCents: toNullableCents(creditData.availableCreditLimit),
    balanceCloseDate: toDate(creditData.balanceCloseDate),
    balanceDueDate: toDate(creditData.balanceDueDate),
    brand: creditData.brand ?? null,
  };
}

function toNullableCents(value: number | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  return toCents(value);
}

function toDate(value: string | null | undefined): Date | null {
  if (value === null || value === undefined || /^\d{4}-\d{2}$/.test(value)) {
    return null;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed;
}

/**
 * `statusDetail` is keyed by product, and a `PARTIAL_SUCCESS` puts the reason one
 * product went unrefreshed in its `warnings`. Flattened with the product name in
 * front, because "credit card bills hit their monthly quota" is the useful
 * sentence and "the monthly quota was reached" on its own is not.
 */
function toWarnings(statusDetail: WireItem["statusDetail"]): readonly string[] {
  if (statusDetail === null || statusDetail === undefined) {
    return [];
  }

  return Object.entries(statusDetail).flatMap(([product, detail]) =>
    (detail?.warnings ?? []).map((warning) => `${product}: ${warning.message}`),
  );
}

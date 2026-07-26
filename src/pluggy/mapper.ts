import { ACCOUNT_TYPES, type Account, type CreditDetails } from "../core/account.ts";
import type { Connection } from "../core/contracts.ts";
import { ResponseShapeError } from "./errors.ts";
import type { WireAccount, WireItem } from "./wire.ts";

/**
 * Where Pluggy's vocabulary stops and ours begins (ADR §14.0). An *item* is a
 * connection, and no domain type past this file mentions the other word.
 *
 * This is also the only place that knows dates arrive as strings, since we
 * parse the raw body rather than going through the SDK's date reviver.
 */
export function toConnection(item: WireItem): Connection {
  return {
    id: item.id,
    institution: item.connector.name,
    status: item.status,
    executionStatus: item.executionStatus ?? null,
    lastUpdatedAt: item.lastUpdatedAt === null ? null : new Date(item.lastUpdatedAt),
    parameter: item.parameter?.label ?? null,
    warnings: toWarnings(item.statusDetail),
  };
}

type DecimalDigits = {
  readonly coefficient: bigint;
  readonly decimalPlaces: number;
};

function parseDecimalDigits(value: number): DecimalDigits {
  const representation = Math.abs(value).toString();
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/.exec(representation);

  if (match === null) {
    throw new Error(`Cannot parse numeric value: ${representation}`);
  }

  const integerDigits = match[1] ?? "0";
  const fractionDigits = match[2] ?? "";
  const exponent = Number(match[3] ?? "0");

  return {
    coefficient: BigInt(`${integerDigits}${fractionDigits}`),
    decimalPlaces: fractionDigits.length - exponent,
  };
}

function roundDecimalCents({ coefficient, decimalPlaces }: DecimalDigits): bigint {
  if (decimalPlaces <= 2) {
    return coefficient * 10n ** BigInt(2 - decimalPlaces);
  }

  const divisor = 10n ** BigInt(decimalPlaces - 2);
  const whole = coefficient / divisor;
  const remainder = coefficient % divisor;
  return whole + (remainder * 2n >= divisor ? 1n : 0n);
}

/**
 * Money as integer cents, at the one point a Pluggy number becomes ours.
 *
 * The shortest decimal representation preserves the difference between a
 * decimal tie such as `1.005` and a value explicitly just below it. Parsing
 * its coefficient and exponent as digits avoids binary floating-point
 * arithmetic; division uses the remainder to round half away from zero.
 */
export function toCents(value: number): number {
  if (!Number.isFinite(value)) {
    throw new RangeError("Money value must be finite");
  }

  const sign = value < 0 ? -1 : 1;
  const roundedCents = roundDecimalCents(parseDecimalDigits(value));
  const result = sign * Number(roundedCents);
  if (!Number.isSafeInteger(result)) {
    throw new RangeError("Money value exceeds the safe integer cent range");
  }

  return result === 0 ? 0 : result;
}

/** Maps Pluggy's account vocabulary and raw monetary values onto our domain. */
export function toAccount(account: WireAccount, connection: Connection): Account {
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
    credit: account.type === ACCOUNT_TYPES.credit ? toCreditDetails(account.creditData) : null,
  };
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
  return value === null || value === undefined ? null : toCents(value);
}

function toDate(value: string | null | undefined): Date | null {
  if (value === null || value === undefined || /^\d{4}-\d{2}$/.test(value)) {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
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

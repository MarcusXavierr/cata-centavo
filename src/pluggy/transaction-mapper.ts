import type { Account, AccountType } from "../core/account.ts";
import { localDayOf } from "../core/date.ts";
import { normalizeDescription } from "../core/description.ts";
import type { Transaction } from "../core/transaction.ts";
import { ResponseShapeError } from "./errors.ts";
import { toCents } from "./money.ts";
import type { WireTransaction } from "./wire.ts";

function toDigits(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  const digits = value.replace(/\D/gu, "");
  if (digits === "") {
    return null;
  }

  return digits;
}

function signFor(type: AccountType): 1 | -1 {
  switch (type) {
    case "BANK":
      return 1;
    case "CREDIT":
      return -1;
    default:
      throw new ResponseShapeError(`${type} accounts have no transaction feed on /v2/transactions`);
  }
}

function localDayOrThrow(value: string): string {
  try {
    return localDayOf(value);
  } catch (error) {
    if (error instanceof RangeError) {
      throw new ResponseShapeError(`Pluggy returned an invalid transaction date: ${value}`);
    }
    throw error;
  }
}

type OriginalDetails = Pick<Transaction, "originalAmountCents" | "originalCurrency">;
type PaymentDetails = Pick<Transaction, "document" | "counterpartyName" | "paymentMethod">;
type CardDetails = Pick<
  Transaction,
  "mcc" | "billId" | "instalmentNumber" | "instalmentTotal" | "purchaseDate"
>;

function originalDetails(wire: WireTransaction, sign: 1 | -1): OriginalDetails {
  const foreign = wire.amountInAccountCurrency !== null && wire.amountInAccountCurrency !== undefined;
  if (!foreign) {
    return { originalAmountCents: null, originalCurrency: null };
  }

  return { originalAmountCents: sign * toCents(wire.amount), originalCurrency: wire.currencyCode ?? null };
}

function paymentDetails(wire: WireTransaction): PaymentDetails {
  if (wire.paymentData === null || wire.paymentData === undefined) {
    return { document: null, counterpartyName: null, paymentMethod: null };
  }

  const receiver = receiverDetails(wire.paymentData.receiver);
  return { ...receiver, paymentMethod: wire.paymentData.paymentMethod ?? null };
}

type Receiver = NonNullable<NonNullable<WireTransaction["paymentData"]>["receiver"]>;

function receiverDetails(receiver: Receiver | null | undefined): Pick<PaymentDetails, "document" | "counterpartyName"> {
  if (receiver === null || receiver === undefined) {
    return { document: null, counterpartyName: null };
  }

  return {
    document: toDigits(receiver.documentNumber?.value),
    counterpartyName: receiver.name ?? null,
  };
}

type CardMetadata = NonNullable<WireTransaction["creditCardMetadata"]>;

function cardDetails(wire: WireTransaction): CardDetails {
  if (wire.creditCardMetadata === null || wire.creditCardMetadata === undefined) {
    return { mcc: null, billId: null, instalmentNumber: null, instalmentTotal: null, purchaseDate: null };
  }

  return cardMetadataDetails(wire.creditCardMetadata);
}

function cardMetadataDetails(metadata: CardMetadata): CardDetails {
  return {
    mcc: mccOf(metadata.payeeMCC),
    billId: stringOrNull(metadata.billId),
    instalmentNumber: numberOrNull(metadata.installmentNumber),
    instalmentTotal: numberOrNull(metadata.totalInstallments),
    purchaseDate: stringOrNull(metadata.purchaseDate),
  };
}

function mccOf(value: number | undefined): string | null {
  if (value === undefined) {
    return null;
  }

  return value.toString();
}

function stringOrNull(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }

  return value;
}

function numberOrNull(value: number | undefined): number | null {
  if (value === undefined) {
    return null;
  }

  return value;
}

/** One Pluggy transaction, in our vocabulary, with the sign normalized. */
export function toTransaction(wire: WireTransaction, account: Account): Transaction {
  const sign = signFor(account.type);
  const original = originalDetails(wire, sign);
  const payment = paymentDetails(wire);
  const card = cardDetails(wire);

  return {
    ...original,
    ...payment,
    ...card,
    id: wire.id,
    accountId: account.id,
    connectionId: account.connectionId,
    accountType: account.type,
    accountSubtype: account.subtype,
    occurredAt: wire.date,
    localDate: localDayOrThrow(wire.date),
    amountCents: sign * toCents(wire.amountInAccountCurrency ?? wire.amount),
    currency: account.currency,
    description: wire.description,
    descriptionNorm: normalizeDescription(wire.description),
    categoryId: wire.categoryId ?? null,
  };
}

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import type { Account } from "../../src/core/account.ts";
import type { Bill } from "../../src/core/bill.ts";
import type { Transaction } from "../../src/core/transaction.ts";
import { connection } from "../fakes/fake-bank.ts";
import { ResponseShapeError } from "../../src/pluggy/errors.ts";
import { toAccount, toBill, toCents, toConnection, toTransaction } from "../../src/pluggy/mapper.ts";
import {
  ACCOUNT_PAGE,
  BILL,
  ITEM,
  TRANSACTION_PAGE,
  type WireAccount,
  type WireBill,
  type WireTransaction,
} from "../../src/pluggy/wire.ts";

function accountFixture(name: string): WireAccount {
  const raw: unknown = JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), "utf8"));
  const [first] = ACCOUNT_PAGE.parse(raw).results;
  assert.ok(first, `${name} fixture has no accounts`);
  return first;
}

describe("toCents", () => {
  const cases = [
    { value: 0, cents: 0, why: "zero survives" },
    { value: 1500, cents: 150000, why: "a whole real" },
    { value: 15.5, cents: 1550, why: "one decimal place" },
    { value: 1234.56, cents: 123456, why: "two decimal places" },
    { value: 1.005, cents: 101, why: "rounds 1.005 up despite binary representation" },
    { value: -1.005, cents: -101, why: "rounds -1.005 down symmetrically" },
    { value: 10.075, cents: 1008, why: "rounds 10.075 up despite binary representation" },
    { value: -10.075, cents: -1008, why: "rounds -10.075 down symmetrically" },
    { value: 1.005 - Number.EPSILON, cents: 100, why: "keeps a positive value just below the tie below it" },
    { value: -(1.005 - Number.EPSILON), cents: -100, why: "keeps a negative value just below the tie symmetric" },
    { value: 1e-7, cents: 0, why: "parses exponent notation" },
    { value: 90071992547409.9, cents: 9007199254740990, why: "keeps a large safe-cent boundary exact" },
    { value: -800.25, cents: -80025, why: "a negative balance" },
    { value: 0.005, cents: 1, why: "half rounds away from zero" },
    { value: -0.005, cents: -1, why: "and symmetrically below zero" },
    { value: -0.001, cents: 0, why: "rounds to positive zero, never -0" },
  ];

  for (const { value, cents, why } of cases) {
    it(why, () => {
      assert.equal(toCents(value), cents);
    });
  }

  it("is symmetric across zero", () => {
    assert.equal(toCents(-1.005), -toCents(1.005));
  });

  const rejectedValues = [
    { value: Number.NaN, why: "rejects NaN", message: "Money value must be finite" },
    { value: Number.POSITIVE_INFINITY, why: "rejects positive infinity", message: "Money value must be finite" },
    { value: Number.NEGATIVE_INFINITY, why: "rejects negative infinity", message: "Money value must be finite" },
    {
      value: 1e14,
      why: "rejects cents beyond the safe integer range",
      message: "Money value exceeds the safe integer cent range",
    },
  ];

  for (const { value, why, message } of rejectedValues) {
    it(why, () => {
      assert.throws(
        () => toCents(value),
        (error: unknown) => error instanceof RangeError && error.message === message,
      );
    });
  }
});

describe("toAccount", () => {
  const conn = connection("conn-1");
  const bankWire = accountFixture("accounts-bank");

  it("maps a bank account onto our shape", () => {
    assert.deepEqual(toAccount(bankWire, conn), {
      id: "account-bank-fixture",
      connectionId: "conn-1",
      institution: "Nubank",
      name: "Synthetic Checking Account",
      type: "BANK",
      subtype: "CHECKING_ACCOUNT",
      amountCents: 12345,
      currency: "BRL",
      lastUpdatedAt: new Date("2026-07-25T09:00:00.000Z"),
      credit: null,
    });
  });

  it("maps a credit card onto our shape", () => {
    assert.deepEqual(toAccount(accountFixture("accounts-credit"), conn), {
      id: "account-credit-fixture",
      connectionId: "conn-1",
      institution: "Nubank",
      name: "Synthetic Credit Card",
      type: "CREDIT",
      subtype: "CREDIT_CARD",
      amountCents: 26550,
      currency: "BRL",
      lastUpdatedAt: new Date("2026-07-25T09:00:00.000Z"),
      credit: {
        limitCents: 320000,
        availableLimitCents: 293450,
        balanceCloseDate: null,
        balanceDueDate: new Date("2026-08-15"),
        brand: "MASTERCARD",
      },
    });
  });

  it("keeps credit details null when Pluggy omits them", () => {
    const creditWire = accountFixture("accounts-credit");

    for (const creditData of [null, undefined]) {
      assert.equal(toAccount({ ...creditWire, creditData }, conn).credit, null);
    }
  });

  it("maps nullable and absent credit fields to null", () => {
    const creditWire = accountFixture("accounts-credit");
    assert.ok(creditWire.creditData);

    const account = toAccount(
      {
        ...creditWire,
        creditData: {
          ...creditWire.creditData,
          creditLimit: null,
          availableCreditLimit: undefined,
          balanceCloseDate: undefined,
          balanceDueDate: null,
        },
      },
      conn,
    );

    assert.deepEqual(account.credit, {
      limitCents: null,
      availableLimitCents: null,
      balanceCloseDate: null,
      balanceDueDate: null,
      brand: "MASTERCARD",
    });
  });

  it("ignores unexpected credit data on a bank account", () => {
    const creditWire = accountFixture("accounts-credit");
    assert.ok(creditWire.creditData);

    assert.equal(toAccount({ ...bankWire, creditData: creditWire.creditData }, conn).credit, null);
  });

  it("takes freshness from the connection, not the account", () => {
    const freshConnection = connection("conn-1", {
      lastUpdatedAt: new Date("2026-07-26T12:00:00.000Z"),
    });

    assert.deepEqual(toAccount(bankWire, freshConnection).lastUpdatedAt, new Date("2026-07-26T12:00:00.000Z"));
  });

  it("keeps the reported balance when the credit limits agree", () => {
    const account = toAccount(accountFixture("accounts-credit"), conn);
    assert.ok(account.credit);
    const { limitCents, availableLimitCents } = account.credit;
    assert.ok(limitCents !== null && availableLimitCents !== null);
    assert.equal(account.amountCents, limitCents - availableLimitCents);
  });

  it("preserves a credit card's reported balance when its limits disagree", () => {
    const creditWire = accountFixture("accounts-credit");
    assert.ok(creditWire.creditData);
    const account = toAccount(
      {
        ...creditWire,
        balance: 79.5,
        creditData: {
          ...creditWire.creditData,
          creditLimit: 6000,
          availableCreditLimit: 2570.5,
        },
      },
      conn,
    );

    assert.equal(account.amountCents, 7950);
    assert.ok(account.credit);
    const { limitCents, availableLimitCents } = account.credit;
    assert.ok(limitCents !== null && availableLimitCents !== null);
    assert.equal(limitCents - availableLimitCents, 342950);
  });

  it("reports the utilization Pluggy sent, not the limit subtraction", () => {
    const account = toAccount(accountFixture("accounts-credit-customized-limit"), conn);

    assert.equal(account.amountCents, 9852);
    assert.notEqual(account.amountCents, 344852, "utilization must come from Pluggy's balance");
  });

  it("prefers the cardholder's customized limit over the bank's headline limit", () => {
    const account = toAccount(accountFixture("accounts-credit-customized-limit"), conn);

    assert.ok(account.credit);
    assert.equal(account.credit.limitCents, 210000);
    assert.equal(account.credit.availableLimitCents, 200148);
  });

  it("falls back to creditLimit when no customized limit is reported", () => {
    const account = toAccount(accountFixture("accounts-credit"), conn);

    assert.ok(account.credit);
    assert.equal(account.credit.limitCents, 320000);
  });

  it("drops unparseable dates instead of yielding an Invalid Date", () => {
    const wire = accountFixture("accounts-credit");
    assert.ok(wire.creditData);

    for (const balanceDueDate of ["0001-01", "not-a-date"]) {
      const account = toAccount(
        { ...wire, creditData: { ...wire.creditData, balanceDueDate } },
        conn,
      );

      assert.ok(account.credit);
      assert.equal(account.credit.balanceDueDate, null);
    }
  });

  it("rejects an account type we do not recognise", () => {
    assert.throws(
      () => toAccount({ ...bankWire, type: "SOMETHING_NEW" }, conn),
      (error: unknown) => error instanceof ResponseShapeError && error.message.includes("SOMETHING_NEW"),
    );
  });

  it("ignores an advisory status detail with no product details", () => {
    const connection = toConnection(
      ITEM.parse({
        id: "conn-1",
        connector: { name: "Nubank" },
        status: "UPDATED",
        lastUpdatedAt: null,
        statusDetail: { accounts: null },
      }),
    );

    assert.deepEqual(connection.warnings, []);
  });
});

const WIRE: ReadonlyMap<string, WireTransaction> = new Map(
  TRANSACTION_PAGE.parse(
    JSON.parse(readFileSync(new URL("../fixtures/transactions-page.json", import.meta.url), "utf8")),
  ).results.map((row) => [row.id, row]),
);

function wireRow(id: string): WireTransaction {
  const found = WIRE.get(id);
  assert.ok(found, `fixture is missing ${id}`);
  return found;
}

const BANK_ACCOUNT: Account = {
  id: "acc-bank",
  connectionId: "conn-1",
  institution: "Test Bank",
  name: "Checking",
  type: "BANK",
  subtype: "CHECKING_ACCOUNT",
  amountCents: 100_000,
  currency: "BRL",
  lastUpdatedAt: new Date("2026-07-26T12:00:00.000Z"),
  credit: null,
};

const CARD_ACCOUNT: Account = { ...BANK_ACCOUNT, id: "acc-card", name: "Card", type: "CREDIT", subtype: "CREDIT_CARD" };

function wireBill(overrides: Record<string, unknown>): WireBill {
  return BILL.parse({
    id: "bill-1",
    accountId: CARD_ACCOUNT.id,
    billClosingDate: "2026-08-01T03:00:00.000Z",
    dueDate: "2026-08-15T03:00:00.000Z",
    totalAmount: 300,
    totalAmountCurrencyCode: "BRL",
    minimumPaymentAmount: 30,
    financeCharges: [],
    payments: [],
    ...overrides,
  });
}

describe("toBill", () => {
  const BILL_CASES: readonly {
    readonly name: string;
    readonly wire: Record<string, unknown>;
    readonly expected: Partial<Bill>;
  }[] = [
    {
      name: "sums finance charges and payments rather than passing the arrays",
      wire: { financeCharges: [{ amount: 1.5 }, { amount: 2.25 }], payments: [{ amount: 10 }, { amount: 5 }] },
      expected: { financeChargesCents: 375, paymentsCents: 1_500, paymentCount: 2 },
    },
    { name: "rounds four decimals half away from zero", wire: { totalAmount: 307.8891 }, expected: { totalCents: 30_789 } },
    { name: "keeps a null closing date rather than inventing one", wire: { billClosingDate: null }, expected: { closingDate: null } },
    { name: "reduces a UTC midnight to its calendar day", wire: { dueDate: "2026-08-15T00:00:00.000Z" }, expected: { dueDate: "2026-08-15" } },
    { name: "reduces the sandbox connector's 03:00Z to the same day", wire: { dueDate: "2026-08-15T03:00:00.000Z" }, expected: { dueDate: "2026-08-15" } },
    { name: "falls back to the account currency when the bill omits one", wire: { totalAmountCurrencyCode: null }, expected: { currency: "BRL" } },
  ];

  for (const { name, wire, expected } of BILL_CASES) {
    it(name, () => {
      const bill = toBill(wireBill(wire), CARD_ACCOUNT);

      for (const [key, value] of Object.entries(expected)) {
        assert.deepEqual(bill[key as keyof Bill], value, key);
      }
    });
  }
});

describe("toTransaction", () => {
  const SIGN_CASES: readonly { readonly name: string; readonly id: string; readonly account: Account; readonly cents: number }[] = [
    { name: "a bank debit stays negative", id: "t-bank-1", account: BANK_ACCOUNT, cents: -15_050 },
    { name: "a card purchase flips to negative", id: "t-card-1", account: CARD_ACCOUNT, cents: -8_990 },
    { name: "a foreign card purchase flips and converts", id: "t-card-foreign", account: CARD_ACCOUNT, cents: -10_000 },
  ];

  for (const { name, id, account, cents } of SIGN_CASES) {
    it(`normalizes the sign so money out is negative: ${name}`, () => {
      assert.equal(toTransaction(wireRow(id), account).amountCents, cents);
    });
  }

  it("denominates in the account's currency, not the purchase's", () => {
    const transaction = toTransaction(wireRow("t-card-foreign"), CARD_ACCOUNT);

    assert.equal(transaction.currency, "BRL");
    assert.equal(transaction.originalCurrency, "USD");
    assert.equal(transaction.originalAmountCents, -2_000);
  });

  it("leaves the original blank on a domestic purchase", () => {
    const transaction = toTransaction(wireRow("t-card-1"), CARD_ACCOUNT);

    assert.equal(transaction.originalCurrency, null);
    assert.equal(transaction.originalAmountCents, null);
  });

  it("rounds sub-cent money through toCents rather than refusing", () => {
    assert.equal(toTransaction(wireRow("t-card-subcent"), CARD_ACCOUNT).amountCents, -30_789);
  });

  const DATE_CASES: readonly { readonly name: string; readonly id: string; readonly localDate: string }[] = [
    { name: "Brazilian midnight rendered as UTC", id: "t-card-1", localDate: "2026-06-20" },
    { name: "a late evening purchase", id: "t-card-late", localDate: "2026-06-30" },
  ];

  for (const { name, id, localDate } of DATE_CASES) {
    it(`truncates dates in São Paulo: ${name}`, () => {
      assert.equal(toTransaction(wireRow(id), CARD_ACCOUNT).localDate, localDate);
    });
  }

  const EXTRACTION_CASES: readonly {
    readonly name: string;
    readonly id: string;
    readonly account: Account;
    readonly expected: Partial<Transaction>;
  }[] = [
    {
      name: "a bank row carries a document and a payment method, and no card fields",
      id: "t-bank-1",
      account: BANK_ACCOUNT,
      expected: {
        document: "12345678900",
        counterpartyName: "MARIA SILVA",
        paymentMethod: "PIX",
        mcc: null,
        billId: null,
        instalmentNumber: null,
        categoryId: "05020000",
      },
    },
    {
      name: "a card row carries card fields and no document",
      id: "t-card-1",
      account: CARD_ACCOUNT,
      expected: {
        document: null,
        counterpartyName: null,
        mcc: "5814",
        billId: "bill-1",
        instalmentNumber: 3,
        instalmentTotal: 12,
        purchaseDate: "2026-04-20",
      },
    },
    {
      name: "an omitted nested key reads as null, not undefined",
      id: "t-card-foreign",
      account: CARD_ACCOUNT,
      expected: { instalmentNumber: null, instalmentTotal: null, purchaseDate: null },
    },
  ];

  for (const { name, id, account, expected } of EXTRACTION_CASES) {
    it(`extracts the detail fields: ${name}`, () => {
      const transaction = toTransaction(wireRow(id), account);

      for (const [key, value] of Object.entries(expected)) {
        assert.deepEqual(transaction[key as keyof Transaction], value, key);
      }
    });
  }

  const FORECAST_CASES: readonly { readonly name: string; readonly id: string; readonly expected: string | null }[] = [
    { name: "carries a forecast cycle", id: "t-card-fc-cycle", expected: "2026-08" },
    { name: "carries the unassigned-cycle sentinel verbatim", id: "t-card-fc-sentinel", expected: "0001-01" },
    { name: "is null when the nested key is omitted", id: "t-card-fc-absent", expected: null },
  ];

  for (const testCase of FORECAST_CASES) {
    it(testCase.name, () => {
      assert.equal(toTransaction(wireRow(testCase.id), CARD_ACCOUNT).billForecastDate, testCase.expected);
    });
  }

  it("refuses an account type that cannot reach this endpoint", () => {
    const investment: Account = { ...BANK_ACCOUNT, type: "INVESTMENT" };

    assert.throws(() => toTransaction(wireRow("t-bank-1"), investment), /INVESTMENT/u);
  });

  it("reports an unparseable date as a wire problem", () => {
    assert.throws(() => toTransaction({ ...wireRow("t-bank-1"), date: "nope" }, BANK_ACCOUNT), ResponseShapeError);
  });
});

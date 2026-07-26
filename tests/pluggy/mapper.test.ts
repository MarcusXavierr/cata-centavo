import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { connection } from "../fakes/fake-bank.ts";
import { ResponseShapeError } from "../../src/pluggy/errors.ts";
import { toAccount, toCents, toConnection } from "../../src/pluggy/mapper.ts";
import { ACCOUNT_PAGE, ITEM, type WireAccount } from "../../src/pluggy/wire.ts";

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

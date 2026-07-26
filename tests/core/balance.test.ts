import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { summarize, type Summary } from "../../src/core/balance.ts";
import { account } from "../fakes/fake-bank.ts";

describe("summarize", () => {
  const cases: readonly {
    readonly why: string;
    readonly accounts: readonly ReturnType<typeof account>[];
    readonly expected: Summary;
  }[] = [
    {
      why: "a card bill never lands in cash",
      accounts: [
        account("a", { type: "BANK", amountCents: 150_000 }),
        account("b", { type: "BANK", amountCents: 50_000 }),
        account("c", { type: "CREDIT", amountCents: 80_000 }),
      ],
      expected: { cashCents: 200_000, creditUsedCents: 80_000, currency: "BRL", accountsCounted: 3 },
    },
    {
      why: "an exactly-zero balance is counted, not dropped",
      accounts: [
        account("a", { type: "BANK", amountCents: 0 }),
        account("b", { type: "BANK", amountCents: 30_000 }),
      ],
      expected: { cashCents: 30_000, creditUsedCents: 0, currency: "BRL", accountsCounted: 2 },
    },
    {
      why: "a loan is kept apart from a card bill",
      accounts: [
        account("a", { type: "CREDIT", amountCents: 80_000 }),
        account("b", { type: "LOAN", amountCents: 2_200_000 }),
      ],
      expected: {
        cashCents: 0,
        creditUsedCents: 80_000,
        loanCents: 2_200_000,
        currency: "BRL",
        accountsCounted: 2,
      },
    },
    {
      why: "investments are totalled separately from cash",
      accounts: [
        account("a", { type: "BANK", amountCents: 150_000 }),
        account("b", { type: "INVESTMENT", amountCents: 80_000 }),
      ],
      expected: {
        cashCents: 150_000,
        creditUsedCents: 0,
        investedCents: 80_000,
        currency: "BRL",
        accountsCounted: 2,
      },
    },
  ];

  for (const { why, accounts, expected } of cases) {
    it(why, () => {
      const result = summarize(accounts);

      assert.equal(result.ok, true);
      assert.deepEqual(result.summary, expected);
    });
  }

  it("omits invested when no investment account exists", () => {
    const result = summarize([account("a", { type: "BANK", amountCents: 30_000 })]);

    assert.equal(result.ok, true);
    assert.ok(!("investedCents" in result.summary));
  });

  it("refuses to total across currencies and sorts the currencies", () => {
    const result = summarize([
      account("a", { type: "BANK", amountCents: 20_000, currency: "USD" }),
      account("b", { type: "BANK", amountCents: 150_000, currency: "BRL" }),
    ]);

    assert.equal(result.ok, false);
    assert.deepEqual(result.currencies, ["BRL", "USD"]);
  });

  it("refuses an empty account list rather than inventing a currency", () => {
    const result = summarize([]);

    assert.equal(result.ok, false);
  });
});

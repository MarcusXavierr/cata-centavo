import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { CONSENT_PAGE, INVESTMENT_PAGE, ITEM, parseCategoryPage, TRANSACTION_PAGE } from "../../src/pluggy/wire.ts";

function consentFixture(): unknown {
  return JSON.parse(readFileSync(new URL("../fixtures/consent.json", import.meta.url), "utf8"));
}

function investmentBody(id: string, overrides: Record<string, unknown> = {}): unknown {
  return {
    id,
    name: `Investment ${id}`,
    balance: 123.45,
    currencyCode: "BRL",
    type: "CDB",
    ...overrides,
  };
}

test("the category page refuses to be one of several", () => {
  assert.throws(() => parseCategoryPage({ results: [], total: 900, totalPages: 2, page: 1 }), /totalPages/u);
});

test("the category page accepts a single page", () => {
  assert.deepEqual(parseCategoryPage({ results: [], total: 0, totalPages: 1, page: 1 }), []);
});

test("transaction receiver names may be null on live Pluggy rows", () => {
  assert.doesNotThrow(() => TRANSACTION_PAGE.parse({
    results: [{
      id: "transaction-1",
      accountId: "account-1",
      date: "2026-06-20T03:00:00.000Z",
      description: "Transfer",
      amount: 10,
      paymentData: { receiver: { name: null } },
    }],
    next: null,
  }));
});

test("PIX receiver documentNumber may be null on live Pluggy rows", () => {
  assert.doesNotThrow(() => TRANSACTION_PAGE.parse({
    results: [{
      id: "transaction-1",
      accountId: "account-1",
      date: "2026-06-20T03:00:00.000Z",
      description: "Pix recebido",
      amount: 10,
      paymentData: { receiver: { name: "MARIA SILVA", documentNumber: null } },
    }],
    next: null,
  }));
});

test("the consent page parses a real-shaped body", () => {
  const parsed = CONSENT_PAGE.parse(consentFixture());

  assert.deepEqual(parsed.results[0], {
    id: "consent-fixture",
    expiresAt: null,
    revokedAt: null,
    products: [
      "ACCOUNTS",
      "CREDIT_CARDS",
      "TRANSACTIONS",
      "IDENTITY",
      "INVESTMENTS",
      "LOANS",
      "FINANCINGS",
      "INVOICE_FINANCINGS",
      "CREDIT_CARDS_BILLS",
    ],
  });
});

test("the consent's own itemId is dropped rather than kept, since it belongs to a different item", () => {
  const parsed = CONSENT_PAGE.parse(consentFixture());

  assert.equal("itemId" in parsed.results[0]!, false);
});

test("an unknown extra key on a consent is dropped rather than rejected", () => {
  const raw = consentFixture() as { results: unknown[] };
  const withExtra = {
    ...raw,
    results: [{ ...(raw.results[0] as Record<string, unknown>), unexpectedField: "surprise" }],
  };

  assert.doesNotThrow(() => CONSENT_PAGE.parse(withExtra));
});

test("ITEM still parses without consecutiveFailedLoginAttempts", () => {
  assert.doesNotThrow(() =>
    ITEM.parse({
      id: "item-1",
      connector: { name: "Nubank" },
      status: "UPDATED",
      executionStatus: "SUCCESS",
      lastUpdatedAt: "2026-07-25T09:00:00.000Z",
    }),
  );
});

test("the investment page parses the required position fields", () => {
  const parsed = INVESTMENT_PAGE.parse({
    total: 1,
    totalPages: 1,
    page: 1,
    results: [investmentBody("investment-1")],
  });

  assert.deepEqual(parsed.results[0], {
    id: "investment-1",
    name: "Investment investment-1",
    balance: 123.45,
    currencyCode: "BRL",
    type: "CDB",
  });
});

test("the investment page accepts omitted and null optional position fields", () => {
  assert.doesNotThrow(() => INVESTMENT_PAGE.parse({
    total: 1,
    totalPages: 1,
    page: 1,
    results: [investmentBody("omitted")],
  }));

  assert.doesNotThrow(() => INVESTMENT_PAGE.parse({
    total: 1,
    totalPages: 1,
    page: 1,
    results: [investmentBody("null", { subtype: null, quantity: null, amount: null, status: null })],
  }));
});

test("the investment page drops nested transactions", () => {
  const parsed = INVESTMENT_PAGE.parse({
    total: 1,
    totalPages: 1,
    page: 1,
    results: [investmentBody("investment-1", { transactions: [{ id: "transaction-1" }] })],
  });

  assert.equal("transactions" in parsed.results[0]!, false);
});

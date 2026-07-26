import assert from "node:assert/strict";
import { test } from "node:test";

import { parseCategoryPage, TRANSACTION_PAGE } from "../../src/pluggy/wire.ts";

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

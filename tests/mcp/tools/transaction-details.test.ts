import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { TransactionReader } from "../../../src/core/transactions.ts";
import { handleGetTransactionDetails } from "../../../src/mcp/tools/transaction-details.ts";
import type { ToolDeps } from "../../../src/mcp/tools/result.ts";
import { fakeLogger } from "../../fakes/fake-logger.ts";
import { account, connection } from "../../fakes/fake-bank.ts";
import { fakeSource } from "../../fakes/fake-source.ts";
import { tx } from "../../fakes/transaction-builder.ts";

function depsWith(rows: readonly ReturnType<typeof tx>[]): ToolDeps {
  const source = fakeSource({ connections: [connection("conn-1")], accounts: { "conn-1": [account("acc-1")] } });
  const reader: TransactionReader = {
    load: async () => ({ accounts: [account("acc-1")], unavailable: [] }),
    query: () => [],
    byIds: (ids) => rows.filter((row) => ids.includes(row.id)),
    dataThrough: () => new Map(),
  };
  return { source, reader, clock: { now: () => new Date("2026-07-01T12:00:00.000Z") }, log: fakeLogger() };
}

function textOf(result: { readonly content: readonly { readonly type: string; readonly text?: string }[] }): string {
  const first = result.content[0];
  assert.ok(first !== undefined);
  assert.equal(first.type, "text");
  assert.ok(first.text !== undefined);
  return first.text;
}

function seededRows(): readonly ReturnType<typeof tx>[] {
  return [
    tx({
      id: "t-card-1",
      accountType: "CREDIT",
      accountSubtype: "CREDIT_CARD",
      amountCents: -8_990,
      description: "Original description",
      descriptionNorm: "ORIGINAL DESCRIPTION",
      document: "12345678000199",
      counterpartyName: "Shop Ltda",
      paymentMethod: "CREDIT",
      mcc: "5411",
      billId: "bill-1",
      instalmentNumber: 3,
      instalmentTotal: 12,
      purchaseDate: "2026-04-15",
    }),
    tx({ id: "t-bank-1", instalmentNumber: null, instalmentTotal: null }),
    tx({
      id: "t-card-foreign",
      accountType: "CREDIT",
      amountCents: -2_500,
      originalAmountCents: -2_000,
      originalCurrency: "USD",
    }),
  ];
}

describe("getTransactionDetails", () => {
  it("returns our field names, not Pluggy's", async () => {
    const result = await handleGetTransactionDetails(depsWith(seededRows()), { ids: ["t-card-1"] });
    const [detail] = JSON.parse(textOf(result)).transactions;

    assert.equal(detail.paymentData, undefined);
    assert.equal(detail.creditCardMetadata, undefined);
    assert.equal(detail.instalment.number, 3);
    assert.equal(detail.instalment.total, 12);
    assert.equal(detail.counterparty.document, "12345678000199");
    assert.equal(detail.counterparty.name, "Shop Ltda");
  });

  it("returns money as a decimal string", async () => {
    const result = await handleGetTransactionDetails(depsWith(seededRows()), { ids: ["t-card-1"] });

    assert.equal(JSON.parse(textOf(result)).transactions[0].amount, "-89.90");
  });

  it("omits the instalment block entirely when there is none", async () => {
    const result = await handleGetTransactionDetails(depsWith(seededRows()), { ids: ["t-bank-1"] });

    assert.equal(JSON.parse(textOf(result)).transactions[0].instalment, undefined);
  });

  it("reports the original amount on a foreign purchase", async () => {
    const result = await handleGetTransactionDetails(depsWith(seededRows()), { ids: ["t-card-foreign"] });
    const [detail] = JSON.parse(textOf(result)).transactions;

    assert.equal(detail.original.amount, "-20.00");
    assert.equal(detail.original.currency, "USD");
  });

  it("names an unknown id rather than dropping it", async () => {
    const result = await handleGetTransactionDetails(depsWith(seededRows()), { ids: ["t-card-1", "nope"] });

    assert.equal(result.isError, true);
    assert.match(textOf(result), /nope/u);
  });

  const ID_COUNT_CASES: readonly { readonly name: string; readonly count: number; readonly ok: boolean }[] = [
    { name: "one id", count: 1, ok: true },
    { name: "the cap itself", count: 20, ok: true },
    { name: "one over the cap", count: 21, ok: false },
    { name: "none", count: 0, ok: false },
  ];

  for (const { name, count, ok } of ID_COUNT_CASES) {
    it(`enforces the id count: ${name}`, async () => {
      const ids = Array.from({ length: count }, (_, index) => `t-${index}`);
      const result = await handleGetTransactionDetails(depsWith(ids.map((id) => tx({ id }))), { ids });

      assert.equal(result.isError !== true, ok);
    });
  }

  it("refuses duplicate ids rather than returning a row twice", async () => {
    const result = await handleGetTransactionDetails(depsWith(seededRows()), { ids: ["t-card-1", "t-card-1"] });

    assert.equal(result.isError, true);
  });
});

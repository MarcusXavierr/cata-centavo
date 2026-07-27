import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { ToolDeps } from "../../../src/mcp/tools/result.ts";
import { handleGetBills } from "../../../src/mcp/tools/bills.ts";
import { bill } from "../../fakes/bill-builder.ts";
import { account } from "../../fakes/fake-bank.ts";
import { fakeLogger } from "../../fakes/fake-logger.ts";
import { fakeSource } from "../../fakes/fake-source.ts";
import type { FakeSource } from "../../fakes/fake-source.ts";

function depsWith(source: FakeSource = fakeSource()): ToolDeps {
  return {
    source,
    log: fakeLogger(),
    reader: source.reader,
    writer: source.writer,
    clock: { now: () => new Date() },
  };
}

function payload(result: CallToolResult): unknown {
  return JSON.parse(message(result));
}

function message(result: CallToolResult): string {
  const first = result.content[0];
  assert.ok(first !== undefined && first.type === "text");
  return first.text;
}

describe("getBills", () => {
  it("returns an empty bill list as a normal result", async () => {
    const result = await handleGetBills(depsWith(), { accountId: "acc-2" });

    assert.notEqual(result.isError, true);
    assert.deepEqual(payload(result), { bills: [] });
  });

  const LIMIT_CASES: readonly {
    readonly name: string;
    readonly input: { readonly accountId: string; readonly limit?: number };
    readonly expectedCount: number;
  }[] = [
    { name: "an explicit limit", input: { accountId: "acc-2", limit: 3 }, expectedCount: 3 },
    { name: "the default limit", input: { accountId: "acc-2" }, expectedCount: 12 },
  ];

  for (const testCase of LIMIT_CASES) {
    it(`limits the response with ${testCase.name}`, async () => {
      const bills = Array.from({ length: 13 }, (_, index) => bill({ id: `bill-${index + 1}` }));
      const source = fakeSource({ bills: { "acc-2": bills } });

      const result = await handleGetBills(depsWith(source), testCase.input);
      const resultPayload = payload(result) as { readonly bills: readonly { readonly id: string }[] };

      assert.equal(resultPayload.bills.length, testCase.expectedCount);
      assert.deepEqual(
        resultPayload.bills.map(({ id }) => id),
        bills.slice(0, testCase.expectedCount).map(({ id }) => id),
      );
    });
  }

  it("serializes every money amount as a decimal string", async () => {
    const statement = bill({
      totalCents: 12_345,
      minimumPaymentCents: 123,
      financeChargesCents: 456,
      paymentsCents: 789,
      paymentCount: 2,
    });
    const source = fakeSource({ bills: { "acc-2": [statement] } });

    const result = await handleGetBills(depsWith(source), { accountId: "acc-2" });

    assert.deepEqual(payload(result), {
      bills: [{
        id: "bill-1",
        closingDate: "2026-07-08",
        dueDate: "2026-07-15",
        total: "123.45",
        currency: "BRL",
        minimumPayment: "1.23",
        financeCharges: "4.56",
        payments: "7.89",
        paymentCount: 2,
      }],
    });
  });

  it("returns an unknown accountId as readable error content", async () => {
    const result = await handleGetBills(depsWith(), { accountId: "missing-account" });

    assert.equal(result.isError, true);
    assert.match(message(result), /unknown account/i);
  });

  it("refuses an account from an unconfigured connection as unknown", async () => {
    const source = fakeSource({
      accounts: {
        "conn-unconfigured": [
          account("card-unconfigured", {
            connectionId: "conn-unconfigured",
            type: "CREDIT",
            subtype: "CREDIT_CARD",
          }),
        ],
      },
    });

    const result = await handleGetBills(depsWith(source), { accountId: "card-unconfigured" });

    assert.equal(result.isError, true);
    assert.match(message(result), /unknown account/i);
  });

  it("refuses a non-credit account and names its actual type", async () => {
    const result = await handleGetBills(depsWith(), { accountId: "acc-1" });

    assert.equal(result.isError, true);
    assert.match(message(result), /BANK/u);
  });
});

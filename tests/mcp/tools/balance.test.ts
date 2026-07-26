import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { account, connection, threeConnections } from "../../fakes/fake-bank.ts";
import { fakeLogger } from "../../fakes/fake-logger.ts";
import { fakeSource } from "../../fakes/fake-source.ts";
import { handleGetBalance, registerGetBalance } from "../../../src/mcp/tools/balance.ts";

function message(result: { readonly content: readonly { readonly type: string; readonly text?: string }[] }): string {
  const first = result.content[0];
  assert.ok(first !== undefined);
  assert.equal(first.type, "text");
  assert.ok(first.text !== undefined);

  return first.text;
}

function payload(result: { readonly content: readonly { readonly type: string; readonly text?: string }[] }): Record<string, unknown> {
  return JSON.parse(message(result)) as Record<string, unknown>;
}

describe("getBalance", () => {
  const log = fakeLogger();

  const refusals = [
    {
      why: "a connection failed",
      source: () => fakeSource({ unreachable: { "conn-2": new Error("Nubank is unavailable") } }),
      expect: /conn-2/,
    },
    {
      why: "a connection returned no accounts",
      source: () => {
        const fixture = threeConnections();
        return fakeSource({ accounts: { ...fixture.accounts, "conn-2": [] } });
      },
      expect: /no-accounts|returned no accounts/i,
    },
    {
      why: "two currencies are present",
      source: () => {
        const fixture = threeConnections();
        return fakeSource({
          accounts: {
            ...fixture.accounts,
            "conn-2": [account("acc-usd", { connectionId: "conn-2", currency: "USD" })],
          },
        });
      },
      expect: /BRL.*USD/,
    },
  ];

  for (const refusal of refusals) {
    it(`refuses when ${refusal.why}`, async () => {
      const result = await handleGetBalance({ source: refusal.source(), log });

      assert.equal(result.isError, true);
      assert.match(message(result), refusal.expect);
      assert.ok(!("cash" in result));
      assert.doesNotMatch(message(result), /cash|creditUsed|invested|loans/i);
    });
  }

  it("reports cash and credit utilization as separate figures", async () => {
    const source = fakeSource({
      connections: [connection("conn-1")],
      accounts: {
        "conn-1": [
          account("bank", { amountCents: 200_000 }),
          account("card", { type: "CREDIT", amountCents: 80_000 }),
        ],
      },
    });

    const result = await handleGetBalance({ source, log });

    assert.equal(result.isError, undefined);
    assert.deepEqual(payload(result), {
      cash: "2000.00",
      creditUsed: "800.00",
      currency: "BRL",
      accountsCounted: 2,
      asOf: [{ connectionId: "conn-1", lastUpdatedAt: "2026-07-25T09:00:00.000Z" }],
    });
    const resultPayload = payload(result);
    assert.ok(!("total" in resultPayload));
    assert.ok(!("invested" in resultPayload));
    assert.ok(!("loans" in resultPayload));
  });

  it("labels the card total creditUsed, not owed", async () => {
    const source = fakeSource({
      connections: [connection("conn-1")],
      accounts: {
        "conn-1": [
          account("bank", { amountCents: 573 }),
          account("card", { type: "CREDIT", amountCents: 9852 }),
        ],
      },
    });

    const result = await handleGetBalance({ source, log });
    const summary = payload(result);

    assert.equal(summary.creditUsed, "98.52");
    assert.equal("owed" in summary, false);
  });

  it("counts an account holding exactly zero", async () => {
    const source = fakeSource({
      connections: [connection("conn-1")],
      accounts: {
        "conn-1": [account("empty", { amountCents: 0 }), account("funded", { amountCents: 30_000 })],
      },
    });

    const result = await handleGetBalance({ source, log });
    const resultPayload = payload(result);

    assert.equal(resultPayload.cash, "300.00");
    assert.equal(resultPayload.accountsCounted, 2);
  });

  it("omits invested when no investment account exists", async () => {
    const source = fakeSource({
      connections: [connection("conn-1")],
      accounts: { "conn-1": [account("bank", { amountCents: 30_000 })] },
    });

    const result = await handleGetBalance({ source, log });
    const resultPayload = payload(result);

    assert.ok(!("invested" in resultPayload));
    assert.ok(!("loans" in resultPayload));
  });

  it("registers getBalance with its description and handler", async () => {
    const registrations: { name: string; description: string; handler: () => Promise<unknown> }[] = [];
    const server = {
      registerTool(name: string, options: { readonly description: string }, handler: () => Promise<unknown>) {
        registrations.push({ name, description: options.description, handler });
      },
    };

    registerGetBalance(server as unknown as McpServer, { source: fakeSource(), log });

    assert.equal(registrations.length, 1);
    const registration = registrations[0];
    assert.ok(registration !== undefined);
    assert.equal(registration.name, "getBalance");
    assert.match(registration.description, /^Gets consolidated figures across all configured bank connections\.\n\nUse this tool when:/);
    assert.ok((await registration.handler()) !== undefined);
  });
});

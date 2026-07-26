import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { account, threeConnections } from "../../fakes/fake-bank.ts";
import { fakeLogger } from "../../fakes/fake-logger.ts";
import { fakeSource } from "../../fakes/fake-source.ts";
import {
  handleGetAccounts,
  handleGetBalanceByAccount,
  registerGetAccounts,
  registerGetBalanceByAccount,
} from "../../../src/mcp/tools/accounts.ts";
import { registerGetBalance } from "../../../src/mcp/tools/balance.ts";

function payload(result: { readonly content: readonly { readonly type: string; readonly text?: string }[] }): unknown {
  return JSON.parse(message(result));
}

function message(result: { readonly content: readonly { readonly type: string; readonly text?: string }[] }): string {
  const first = result.content[0];
  assert.ok(first !== undefined);
  assert.equal(first.type, "text");
  assert.ok(first.text !== undefined);

  return first.text;
}

describe("MCP account tools", () => {
  const log = fakeLogger();

  it("never describes a credit figure as a bill or debt", () => {
    const descriptions: string[] = [];
    const server = {
      registerTool(_name: string, options: { readonly description: string }): void {
        descriptions.push(options.description);
      },
    };

    registerGetAccounts(server as never, { source: fakeSource(), log });
    registerGetBalanceByAccount(server as never, { source: fakeSource(), log });
    registerGetBalance(server as never, { source: fakeSource(), log });

    for (const description of descriptions) {
      assert.doesNotMatch(description, /\bbill\b/i);
      assert.doesNotMatch(description, /\bdebt\b/i);
    }
  });

  it("passes the requested account id through to the bank", async () => {
    const source = fakeSource();

    await handleGetBalanceByAccount({ source, log }, { accountId: "acc-5" });

    assert.ok(source.bank.calls.includes("getAccount:acc-5"));
  });

  const refusals = [
    {
      why: "an account belonging to an unconfigured connection",
      source: () => {
        const fixture = threeConnections();
        return fakeSource({
          accounts: {
            ...fixture.accounts,
            "conn-unconfigured": [account("acc-unconfigured", { connectionId: "conn-unconfigured" })],
          },
        });
      },
      accountId: "acc-unconfigured",
    },
    {
      why: "an account Pluggy does not recognise",
      source: () => fakeSource(),
      accountId: "missing-account",
    },
  ];

  for (const refusal of refusals) {
    it(`refuses ${refusal.why}`, async () => {
      const result = await handleGetBalanceByAccount({ source: refusal.source(), log }, { accountId: refusal.accountId });

      assert.equal(result.isError, true);
      assert.match(message(result), /unknown account/i);
      assert.doesNotMatch(message(result), /balance/i);
    });
  }

  it("lists every account with the unavailable connections named", async () => {
    const source = fakeSource({ unreachable: { "conn-2": new Error("Nubank is unavailable") } });

    const result = await handleGetAccounts({ source, log });

    assert.equal(result.isError, undefined);
    assert.deepEqual(payload(result), {
      accounts: [
        {
          id: "acc-1",
          connectionId: "conn-1",
          institution: "Nubank",
          name: "Account acc-1",
          type: "BANK",
          subtype: "CHECKING_ACCOUNT",
          balance: "123.45",
          currency: "BRL",
          lastUpdatedAt: "2026-07-25T09:00:00.000Z",
        },
        {
          id: "acc-2",
          connectionId: "conn-1",
          institution: "Nubank",
          name: "Account acc-2",
          type: "CREDIT",
          subtype: "CREDIT_CARD",
          usedCredit: "123.45",
          currency: "BRL",
          lastUpdatedAt: "2026-07-25T09:00:00.000Z",
          credit: {
            limit: "1000.00",
            availableLimit: "800.00",
            brand: "Mastercard",
          },
        },
        {
          id: "acc-5",
          connectionId: "conn-3",
          institution: "Nubank",
          name: "Account acc-5",
          type: "BANK",
          subtype: "CHECKING_ACCOUNT",
          balance: "123.45",
          currency: "BRL",
          lastUpdatedAt: "2026-07-25T09:00:00.000Z",
        },
        {
          id: "acc-6",
          connectionId: "conn-3",
          institution: "Nubank",
          name: "Account acc-6",
          type: "CREDIT",
          subtype: "CREDIT_CARD",
          usedCredit: "123.45",
          currency: "BRL",
          lastUpdatedAt: "2026-07-25T09:00:00.000Z",
          credit: {
            limit: "1000.00",
            availableLimit: "800.00",
            brand: "Mastercard",
          },
        },
      ],
      unavailable: [
        {
          connectionId: "conn-2",
          kind: "unavailable",
          message: "Error: Nubank is unavailable",
        },
      ],
    });
  });

  it("publishes a credit card's figure as usedCredit, never as balance", async () => {
    const result = await handleGetAccounts({ source: fakeSource(), log });
    const accounts = payload(result) as { accounts: { type: string; usedCredit?: string; balance?: string }[] };
    const credit = accounts.accounts.find((candidate) => candidate.type === "CREDIT");

    assert.ok(credit !== undefined);
    assert.equal(credit.usedCredit, "123.45");
    assert.equal("balance" in credit, false);
  });

  it("still publishes a bank account's figure as balance", async () => {
    const result = await handleGetAccounts({ source: fakeSource(), log });
    const accounts = payload(result) as { accounts: { type: string; usedCredit?: string; balance?: string }[] };
    const bank = accounts.accounts.find((candidate) => candidate.type === "BANK");

    assert.ok(bank !== undefined);
    assert.equal(bank.balance, "123.45");
    assert.equal("usedCredit" in bank, false);
  });

  it("reports the config problems when the source is broken", async () => {
    const result = await handleGetAccounts(
      { source: { ok: false, problems: ["PLUGGY_CLIENT_SECRET is missing or empty."] }, log },
    );

    assert.equal(result.isError, true);
    assert.match(message(result), /PLUGGY_CLIENT_SECRET/);
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { investmentPosition } from "../fakes/fake-bank.ts";
import { fakeSource } from "../fakes/fake-source.ts";
import { fakeLogger } from "../fakes/fake-logger.ts";
import { createServer } from "../../src/mcp/server.ts";

describe("MCP server", () => {
  it("lists every tool even when the configuration is broken", async () => {
    const server = createServer({
      source: { ok: false, problems: ["PLUGGY_CLIENT_SECRET is missing or empty."] },
      version: "0.0.0",
      log: fakeLogger(),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.0" });

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const result = await client.listTools();

    assert.deepEqual(result.tools.map(({ name }) => name), [
      "getAccounts",
      "getBalanceByAccount",
      "getBalance",
      "getTransactions",
      "listTransactions",
      "getTransactionDetails",
      "getInvestments",
      "setCategory",
      "setCounterpartyCategory",
      "listClosingDays",
      "setClosingDay",
      "deleteClosingDay",
      "getBills",
      "getBillSummary",
      "listSources",
    ]);


    await client.close();
    await server.close();
  });

  it("invokes getInvestments through the assembled server", async () => {
    const server = createServer({
      source: fakeSource({
        investments: {
          "conn-1": [investmentPosition("pos-1", { balanceCents: 15_000, currency: "BRL" })],
        },
      }),
      version: "0.0.0",
      log: fakeLogger(),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.0" });

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const result = await client.callTool({ name: "getInvestments", arguments: {} });
    const content = (result.content as { type: "text"; text: string }[])[0];
    assert.ok(content !== undefined);
    const payload = JSON.parse(content.text);

    assert.equal(payload.totalPositions, 1);
    assert.deepEqual(payload.totals, [{ currency: "BRL", balance: "150.00" }]);

    await client.close();
    await server.close();
  });
});

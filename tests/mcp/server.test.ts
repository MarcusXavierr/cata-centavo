import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

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
      "setCategory",
      "setCounterpartyCategory",
      "listClosingDays",
      "setClosingDay",
      "deleteClosingDay",
      "listSources",
    ]);


    await client.close();
    await server.close();
  });
});

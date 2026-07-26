import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { Clock, Logger } from "../core/contracts.ts";
import type { Source } from "./source.ts";
import { registerGetAccounts, registerGetBalanceByAccount } from "./tools/accounts.ts";
import { registerGetBalance } from "./tools/balance.ts";
import { registerGetTransactionDetails } from "./tools/transaction-details.ts";
import { registerGetTransactions, registerListTransactions } from "./tools/transactions.ts";

/** Creates the MCP server and registers its financial tools. */
export function createServer(options: {
  readonly source: Source;
  readonly version: string;
  readonly log: Logger;
}): McpServer {
  const server = new McpServer({ name: "cata-centavo", version: options.version });
  const clock: Clock = { now: () => new Date() };
  let reader = null;
  if (options.source.ok) {
    reader = options.source.reader;
  }
  const deps = {
    source: options.source,
    log: options.log,
    reader,
    clock,
  };

  registerGetAccounts(server, deps);
  registerGetBalanceByAccount(server, deps);
  registerGetBalance(server, deps);
  registerGetTransactions(server, deps);
  registerListTransactions(server, deps);
  registerGetTransactionDetails(server, deps);

  return server;
}

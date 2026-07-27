import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { Clock, Logger } from "../core/contracts.ts";
import type { ToolDeps } from "./tools/result.ts";
import type { Source } from "./source.ts";
import { registerGetAccounts, registerGetBalanceByAccount } from "./tools/accounts.ts";
import { registerGetBalance } from "./tools/balance.ts";
import {
  registerDeleteClosingDay,
  registerListClosingDays,
  registerSetClosingDay,
} from "./tools/closing-days.ts";
import { registerListSources } from "./tools/sources.ts";
import { registerGetTransactionDetails } from "./tools/transaction-details.ts";
import { registerGetTransactions, registerListTransactions } from "./tools/transactions.ts";
import { registerSetCategory, registerSetCounterpartyCategory } from "./tools/set-category.ts";

/** Creates the MCP server and registers its financial tools. */
export function createServer(options: {
  readonly source: Source;
  readonly version: string;
  readonly log: Logger;
}): McpServer {
  const server = new McpServer({ name: "cata-centavo", version: options.version });
  const deps = toolDeps(options);

  for (const register of REGISTRARS) {
    register(server, deps);
  }

  return server;
}

/** Every tool this server exposes. One list, so registering is not a place to forget one. */
const REGISTRARS: readonly ((server: McpServer, deps: ToolDeps) => void)[] = [
  registerGetAccounts,
  registerGetBalanceByAccount,
  registerGetBalance,
  registerGetTransactions,
  registerListTransactions,
  registerGetTransactionDetails,
  registerSetCategory,
  registerSetCounterpartyCategory,
  registerListClosingDays,
  registerSetClosingDay,
  registerDeleteClosingDay,
  registerListSources,
];

function toolDeps(options: { readonly source: Source; readonly log: Logger }): ToolDeps {
  const clock: Clock = { now: () => new Date() };
  if (!options.source.ok) {
    return { source: options.source, log: options.log, reader: null, writer: null, closingDays: null, clock };
  }
  return {
    source: options.source,
    log: options.log,
    reader: options.source.reader,
    writer: options.source.writer,
    closingDays: options.source.closingDays ?? null,
    clock,
  };
}

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { Logger } from "../core/contracts.ts";
import type { Source } from "./source.ts";
import { registerGetAccounts, registerGetBalanceByAccount } from "./tools/accounts.ts";
import { registerGetBalance } from "./tools/balance.ts";

/** Creates the MCP server and registers its financial tools. */
export function createServer(options: {
  readonly source: Source;
  readonly version: string;
  readonly log: Logger;
}): McpServer {
  const server = new McpServer({ name: "cata-centavo", version: options.version });
  const deps = { source: options.source, log: options.log };

  registerGetAccounts(server, deps);
  registerGetBalanceByAccount(server, deps);
  registerGetBalance(server, deps);

  return server;
}

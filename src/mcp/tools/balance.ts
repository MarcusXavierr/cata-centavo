import { randomUUID } from "node:crypto";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { collectAccounts } from "../../core/accounts.ts";
import { summarize, type Summary } from "../../core/balance.ts";
import type { Account } from "../../core/account.ts";
import type { Logger } from "../../core/contracts.ts";
import { prune, toDecimal } from "../format.ts";
import type { Source } from "../source.ts";

export type ToolDeps = {
  readonly source: Source;
  readonly log: Logger;
};

export const GET_BALANCE_DESCRIPTION = `Gets consolidated figures across all configured bank connections.

Use this tool when:
- You need total money available without mixing it with what cards have taken.
- You need to know when each connection last supplied its account data.

Returns: \`cash\`, the money available across bank accounts, and \`creditUsed\`, the limit currently taken across cards — never added together, because they are not the same unit. Investment and loan totals when reported, plus the currency, how many accounts were counted, and each source's update time.`;

/** Registers the consolidated balance tool. */
export function registerGetBalance(server: McpServer, deps: ToolDeps): void {
  server.registerTool("getBalance", { description: GET_BALANCE_DESCRIPTION }, async () => handleGetBalance(deps));
}

/** Gets separate totals for every available configured connection. */
export async function handleGetBalance(deps: ToolDeps): Promise<CallToolResult> {
  const startedAt = Date.now();
  const log = deps.log.child({ tool: "getBalance", callId: randomUUID() });
  log.info({}, "getBalance started");

  if (!deps.source.ok) {
    return finishToolError(log, startedAt, configurationProblems(deps.source.problems), { problems: deps.source.problems.length });
  }

  const collected = await collectAccounts(deps.source.bank, deps.source.connections, deps.source.toFailure);
  if (collected.unavailable.length > 0) {
    logUnavailableConnections(log, collected.accounts.length, collected.unavailable);

    return finishToolError(log, startedAt, unavailableMessage(collected.unavailable), {
      accounts: collected.accounts.length,
      unavailable: collected.unavailable.length,
    });
  }

  const summary = summarize(collected.accounts);
  if (!summary.ok) {
    return finishToolError(log, startedAt, mixedCurrencyMessage(summary.currencies), { currencies: summary.currencies });
  }

  const response = formatSummary(summary.summary, collected.accounts);
  log.debug({ balance: response }, "getBalance returned consolidated balances");
  log.info(
    { durationMs: Date.now() - startedAt, outcome: "ok", accounts: summary.summary.accountsCounted },
    "getBalance finished",
  );

  return textResult(response);
}

function logUnavailableConnections(
  log: Logger,
  accounts: number,
  unavailable: readonly { readonly connectionId: string; readonly kind: string; readonly message: string }[],
): void {
  for (const connection of unavailable) {
    log.warn(
      {
        connectionId: connection.connectionId,
        kind: connection.kind,
        message: connection.message,
        accounts,
        unavailable: unavailable.length,
      },
      "Connection unavailable",
    );
  }
}

function unavailableMessage(unavailable: readonly { readonly connectionId: string; readonly kind: string; readonly message: string }[]): string {
  return `Cannot consolidate balances because ${unavailable
    .map(({ connectionId, kind, message }) => `${connectionId} (${kind}): ${message}`)
    .join("; ")}`;
}

function mixedCurrencyMessage(currencies: readonly string[]): string {
  return `Cannot consolidate balances across currencies: ${currencies.join(", ")}.`;
}

function formatSummary(summary: Summary, accounts: readonly Account[]): unknown {
  let investedField: { invested: string } | Record<string, never>;
  if (summary.investedCents === undefined) {
    investedField = {};
  } else {
    investedField = { invested: toDecimal(summary.investedCents) };
  }

  let loansField: { loans: string } | Record<string, never>;
  if (summary.loanCents === undefined) {
    loansField = {};
  } else {
    loansField = { loans: toDecimal(summary.loanCents) };
  }

  return {
    cash: toDecimal(summary.cashCents),
    creditUsed: toDecimal(summary.creditUsedCents),
    ...investedField,
    ...loansField,
    currency: summary.currency,
    accountsCounted: summary.accountsCounted,
    asOf: accountsAsOf(accounts),
  };
}

function accountsAsOf(accounts: readonly Account[]): readonly unknown[] {
  const byConnection = new Map<string, Account>();
  for (const account of accounts) {
    if (!byConnection.has(account.connectionId)) {
      byConnection.set(account.connectionId, account);
    }
  }

  return [...byConnection.values()].map((account) =>
    prune({ connectionId: account.connectionId, lastUpdatedAt: account.lastUpdatedAt?.toISOString() ?? null }),
  );
}

function finishToolError(
  log: Logger,
  startedAt: number,
  message: string,
  fields: Readonly<Record<string, unknown>>,
): CallToolResult {
  log.info({ durationMs: Date.now() - startedAt, outcome: "tool-error", ...fields }, "Tool finished with an error");

  return { content: [{ type: "text", text: message }], isError: true };
}

function configurationProblems(problems: readonly string[]): string {
  return `Configuration problems:\n${problems.join("\n")}`;
}

function textResult(payload: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(prune(payload)) }] };
}

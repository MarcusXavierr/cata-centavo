import { randomUUID } from "node:crypto";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { collectAccounts } from "../../core/accounts.ts";
import { ACCOUNT_TYPES, type Account, type CreditDetails } from "../../core/account.ts";
import type { Logger } from "../../core/contracts.ts";
import { prune, toDecimal } from "../format.ts";
import type { Source } from "../source.ts";

export type ToolDeps = {
  readonly source: Source;
  readonly log: Logger;
};

const getBalanceByAccountInput = z.object({ accountId: z.string().min(1) });

export const GET_ACCOUNTS_DESCRIPTION = `Lists every account across the configured bank connections.

Use this tool when:
- You need an account map before inspecting one account or filtering financial activity.
- You need to see which configured connections could not provide account data.

Returns: Per-account figures in different units. A BANK account reports \`balance\`, the money available. A credit card reports \`usedCredit\`, how much of its limit is currently taken — this mixes the cycle in progress with instalments not yet charged, so it is not what the card owes this month and does not match the statement in a banking app. No tool here reports a card's statement amount.`;

export const GET_BALANCE_BY_ACCOUNT_DESCRIPTION = `Gets the current figures and details for one account.

Use this tool when:
- You need one account's numbers and already have its ID from getAccounts.
- You need that account's credit limit and cycle dates.

Returns: For a BANK account, its balance. For a credit card, \`usedCredit\` — the portion of the limit currently taken, which is not the amount owed for the month. Also the currency, type, credit limit and cycle dates when applicable, and when the connection last supplied data.`;

/** Registers the account map tool. */
export function registerGetAccounts(server: McpServer, deps: ToolDeps): void {
  server.registerTool("getAccounts", { description: GET_ACCOUNTS_DESCRIPTION }, async () => handleGetAccounts(deps));
}

/** Registers the single-account balance tool. */
export function registerGetBalanceByAccount(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "getBalanceByAccount",
    { description: GET_BALANCE_BY_ACCOUNT_DESCRIPTION, inputSchema: getBalanceByAccountInput },
    async (input) => handleGetBalanceByAccount(deps, input),
  );
}

/** Lists accounts from every configured connection, retaining any unavailable connections. */
export async function handleGetAccounts(deps: ToolDeps): Promise<CallToolResult> {
  const startedAt = Date.now();
  const log = deps.log.child({ tool: "getAccounts", callId: randomUUID() });
  log.info({}, "getAccounts started");

  if (!deps.source.ok) {
    return finishToolError(log, startedAt, configurationProblems(deps.source.problems), { problems: deps.source.problems.length });
  }

  const collected = await collectAccounts(deps.source.bank, deps.source.connections, deps.source.toFailure);
  for (const unavailable of collected.unavailable) {
    log.warn(
      {
        connectionId: unavailable.connectionId,
        kind: unavailable.kind,
        message: unavailable.message,
        accounts: collected.accounts.length,
        unavailable: collected.unavailable.length,
      },
      "Connection unavailable",
    );
  }

  const response = { accounts: collected.accounts.map(formatAccount), unavailable: collected.unavailable };
  log.debug({ accounts: response.accounts }, "getAccounts returned account details");
  log.info(
    { durationMs: Date.now() - startedAt, outcome: "ok", accounts: response.accounts.length, unavailable: collected.unavailable.length },
    "getAccounts finished",
  );

  return textResult(response);
}

/** Gets the figures and details of one configured account. */
export async function handleGetBalanceByAccount(deps: ToolDeps, input: unknown): Promise<CallToolResult> {
  const startedAt = Date.now();
  const parsed = getBalanceByAccountInput.parse(input);
  const log = deps.log.child({ tool: "getBalanceByAccount", callId: randomUUID() });
  log.info({ accountId: parsed.accountId }, "getBalanceByAccount started");

  if (!deps.source.ok) {
    return finishToolError(log, startedAt, configurationProblems(deps.source.problems), { problems: deps.source.problems.length });
  }

  try {
    const account = await getConfiguredAccount(deps.source, parsed.accountId);
    if (account === null) {
      return finishToolError(log, startedAt, "Unknown account.", { accounts: 0 });
    }

    const response = formatAccount(account);
    log.debug({ account: response }, "getBalanceByAccount returned account details");
    log.info(
      { durationMs: Date.now() - startedAt, outcome: "ok", accounts: 1 },
      "getBalanceByAccount finished",
    );

    return textResult(response);
  } catch (error) {
    log.info({ durationMs: Date.now() - startedAt, outcome: "crash" }, "getBalanceByAccount crashed");
    throw error;
  }
}

async function getConfiguredAccount(source: Extract<Source, { readonly ok: true }>, accountId: string): Promise<Account | null> {
  try {
    const account = await source.bank.getAccount(accountId);
    if (source.connections.includes(account.connectionId)) {
      return account;
    }
    return null;
  } catch (error) {
    if (source.toFailure(error).kind === "unknown-connection") return null;
    throw error;
  }
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

function formatAccount(account: Account): unknown {
  let amountField: { usedCredit: string } | { balance: string };
  if (account.type === ACCOUNT_TYPES.credit) {
    amountField = { usedCredit: toDecimal(account.amountCents) };
  } else {
    amountField = { balance: toDecimal(account.amountCents) };
  }

  return prune({
    id: account.id,
    connectionId: account.connectionId,
    institution: account.institution,
    name: account.name,
    type: account.type,
    subtype: account.subtype,
    ...amountField,
    currency: account.currency,
    lastUpdatedAt: account.lastUpdatedAt?.toISOString() ?? null,
    credit: formatCredit(account.credit),
  });
}

function formatCredit(credit: CreditDetails | null): unknown {
  if (credit === null) return null;

  return {
    limit: decimalOrNull(credit.limitCents),
    availableLimit: decimalOrNull(credit.availableLimitCents),
    balanceCloseDate: isoOrNull(credit.balanceCloseDate),
    balanceDueDate: isoOrNull(credit.balanceDueDate),
    brand: credit.brand,
  };
}

function decimalOrNull(cents: number | null): string | null {
  if (cents === null) {
    return null;
  }
  return toDecimal(cents);
}

function isoOrNull(date: Date | null): string | null {
  return date?.toISOString() ?? null;
}

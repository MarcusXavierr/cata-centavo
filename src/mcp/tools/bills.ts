import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { ACCOUNT_TYPES, type Account } from "../../core/account.ts";
import type { Bill } from "../../core/bill.ts";
import type { Logger } from "../../core/contracts.ts";
import { toDecimal } from "../format.ts";
import type { Source } from "../source.ts";
import { executeBillSummary } from "./bill-summary.ts";
import {
  configurationProblems,
  finishToolError,
  textResult,
  type ToolDeps,
} from "./result.ts";

export const GET_BILLS_DESCRIPTION = `Credit card statements for one card, newest first.

Use this tool when:
- the user asks what a past bill totalled, or when one was due
- you need the closing day of recent cycles
- the user asks whether a bill was paid

Returns: cycles with closing date, due date, total, minimum payment, finance
charges and payments. Usually these are closed statements, but on some banks the
newest entry is the cycle still in progress — getBillSummary says which. An empty
list means this bank does not publish bills, which is normal on non-regulated
connections.`;

export const GET_BILL_SUMMARY_DESCRIPTION = `The credit card bill currently in progress, as two independent estimates.

Use this tool when:
- the user asks what their open or current bill is
- the user asks how much of the card limit is used
- the user is deciding whether to spend more this cycle

Returns: posted, what has actually posted to the open cycle, valid only through
dataThrough; and committed, the used limit minus instalments scheduled for later
cycles. They are measured differently and neither is a proven bound, so quote
their gap rather than a midpoint. Also returns cycle and limit details, feed
staleness, and the five largest purchases in the cycle.`;

const getBillsSchema = z.object({
  accountId: z.string().min(1),
  limit: z.number().int().min(1).max(100).default(12),
});

const getBillSummarySchema = z.object({
  accountId: z.string().min(1),
});

export function registerGetBills(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "getBills",
    { description: GET_BILLS_DESCRIPTION, inputSchema: getBillsSchema },
    async (input) => handleGetBills(deps, input),
  );
}

export function registerGetBillSummary(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "getBillSummary",
    { description: GET_BILL_SUMMARY_DESCRIPTION, inputSchema: getBillSummarySchema },
    async (input) => handleGetBillSummary(deps, input),
  );
}

export async function handleGetBills(deps: ToolDeps, rawInput: unknown): Promise<CallToolResult> {
  const startedAt = Date.now();
  const parsed = getBillsSchema.safeParse(rawInput);
  if (!parsed.success) {
    return finishToolError(deps.log, startedAt, parsed.error.message, { tool: "getBills" });
  }
  if (!deps.source.ok) {
    return finishToolError(
      deps.log,
      startedAt,
      configurationProblems(deps.source.problems),
      { tool: "getBills" },
    );
  }

  const resolved = await resolveCreditAccount({
    source: deps.source,
    log: deps.log,
    startedAt,
    accountId: parsed.data.accountId,
    tool: "getBills",
  });
  if (!resolved.ok) {
    return resolved.result;
  }

  const bills = await deps.source.bank.getBills(resolved.account);
  return textResult({ bills: bills.slice(0, parsed.data.limit).map(formatBill) });
}

export async function handleGetBillSummary(deps: ToolDeps, rawInput: unknown): Promise<CallToolResult> {
  const startedAt = Date.now();
  const parsed = getBillSummarySchema.safeParse(rawInput);
  if (!parsed.success) {
    return finishToolError(deps.log, startedAt, parsed.error.message, { tool: "getBillSummary" });
  }
  if (!deps.source.ok) {
    return finishToolError(
      deps.log,
      startedAt,
      configurationProblems(deps.source.problems),
      { tool: "getBillSummary" },
    );
  }
  if (deps.reader === null) {
    return finishToolError(
      deps.log,
      startedAt,
      "Transaction reader is unavailable.",
      { tool: "getBillSummary" },
    );
  }

  const source = deps.source;
  const reader = deps.reader;
  const resolved = await resolveCreditAccount({
    source,
    log: deps.log,
    startedAt,
    accountId: parsed.data.accountId,
    tool: "getBillSummary",
  });
  if (!resolved.ok) {
    return resolved.result;
  }

  return executeBillSummary({ deps, source, reader, account: resolved.account, startedAt });
}

type AccountResolution =
  | { readonly ok: true; readonly account: Account }
  | { readonly ok: false; readonly result: CallToolResult };

type AccountResolutionOptions = {
  readonly source: Extract<Source, { readonly ok: true }>;
  readonly log: Logger;
  readonly startedAt: number;
  readonly accountId: string;
  readonly tool: "getBills" | "getBillSummary";
};

async function resolveCreditAccount(options: AccountResolutionOptions): Promise<AccountResolution> {
  const { source, log, startedAt, accountId, tool } = options;
  let account;
  try {
    account = await source.bank.getAccount(accountId);
  } catch (error) {
    if (source.toFailure(error).kind === "unknown-connection") {
      return unknownAccount(log, startedAt, accountId, tool);
    }
    throw error;
  }
  if (!source.connections.includes(account.connectionId)) {
    return unknownAccount(log, startedAt, accountId, tool);
  }
  if (account.type !== ACCOUNT_TYPES.credit) {
    let actualType: string = account.type;
    if (account.subtype !== null) {
      actualType = `${account.type} (${account.subtype})`;
    }
    return {
      ok: false,
      result: finishToolError(
        log,
        startedAt,
        `Account ${account.id} has type ${actualType}; ${tool} requires a CREDIT card.`,
        { tool, accountId: account.id, accountType: account.type, accountSubtype: account.subtype },
      ),
    };
  }
  return { ok: true, account };
}

function unknownAccount(
  log: Logger,
  startedAt: number,
  accountId: string,
  tool: "getBills" | "getBillSummary",
): AccountResolution {
  return {
    ok: false,
    result: finishToolError(log, startedAt, `Unknown account ${accountId}: not found.`, {
      tool,
      accountId,
    }),
  };
}

function formatBill(bill: Bill): unknown {
  let minimumPayment: string | null = null;
  if (bill.minimumPaymentCents !== null) {
    minimumPayment = toDecimal(bill.minimumPaymentCents);
  }

  return {
    id: bill.id,
    closingDate: bill.closingDate,
    dueDate: bill.dueDate,
    total: toDecimal(bill.totalCents),
    currency: bill.currency,
    minimumPayment,
    financeCharges: toDecimal(bill.financeChargesCents),
    payments: toDecimal(bill.paymentsCents),
    paymentCount: bill.paymentCount,
  };
}

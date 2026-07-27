import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { ACCOUNT_TYPES, type Account } from "../../core/account.ts";
import type { Bill } from "../../core/bill.ts";
import type { Logger } from "../../core/contracts.ts";
import { toDecimal } from "../format.ts";
import type { Source } from "../source.ts";
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

const getBillsSchema = z.object({
  accountId: z.string().min(1),
  limit: z.number().int().min(1).max(100).default(12),
});

export function registerGetBills(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "getBills",
    { description: GET_BILLS_DESCRIPTION, inputSchema: getBillsSchema },
    async (input) => handleGetBills(deps, input),
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

  const resolved = await resolveCreditAccount(
    deps.source,
    deps.log,
    startedAt,
    parsed.data.accountId,
  );
  if (!resolved.ok) {
    return resolved.result;
  }

  const bills = await deps.source.bank.getBills(resolved.account);
  return textResult({ bills: bills.slice(0, parsed.data.limit).map(formatBill) });
}

type AccountResolution =
  | { readonly ok: true; readonly account: Account }
  | { readonly ok: false; readonly result: CallToolResult };

async function resolveCreditAccount(
  source: Extract<Source, { readonly ok: true }>,
  log: Logger,
  startedAt: number,
  accountId: string,
): Promise<AccountResolution> {
  let account;
  try {
    account = await source.bank.getAccount(accountId);
  } catch (error) {
    if (source.toFailure(error).kind === "unknown-connection") {
      return unknownAccount(log, startedAt, accountId);
    }
    throw error;
  }
  if (!source.connections.includes(account.connectionId)) {
    return unknownAccount(log, startedAt, accountId);
  }
  if (account.type !== ACCOUNT_TYPES.credit) {
    return {
      ok: false,
      result: finishToolError(
        log,
        startedAt,
        `Account ${account.id} has type ${account.type}; getBills requires a CREDIT account.`,
        { tool: "getBills", accountId: account.id, accountType: account.type },
      ),
    };
  }
  return { ok: true, account };
}

function unknownAccount(log: Logger, startedAt: number, accountId: string): AccountResolution {
  return {
    ok: false,
    result: finishToolError(log, startedAt, "Unknown account.", {
      tool: "getBills",
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

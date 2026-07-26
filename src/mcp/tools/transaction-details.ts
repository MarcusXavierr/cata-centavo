import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type { Transaction } from "../../core/transaction.ts";
import { toDecimal } from "../format.ts";
import { configurationProblems, finishToolError, textResult, type ToolDeps } from "./result.ts";

const getTransactionDetailsInput = z.object({
  ids: z.array(z.string().min(1)).min(1).max(20),
}).superRefine((input, context) => {
  if (new Set(input.ids).size !== input.ids.length) {
    context.addIssue({ code: "custom", path: ["ids"], message: "must not contain duplicates" });
  }
});

type GetTransactionDetailsInput = z.infer<typeof getTransactionDetailsInput>;

export const GET_TRANSACTION_DETAILS_DESCRIPTION = `Returns full details for a bounded set of transaction ids.

Use this tool when:
- You need the counterparty, payment, instalment or card metadata behind a transaction.
- An aggregate sample id or a listed row identifies the transaction to inspect.

Returns: Our transaction fields with money as decimal strings. The request is capped at 20 ids, and unknown ids are reported as an error.`;

export function registerGetTransactionDetails(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "getTransactionDetails",
    { description: GET_TRANSACTION_DETAILS_DESCRIPTION, inputSchema: getTransactionDetailsInput },
    async (input) => handleGetTransactionDetails(deps, input),
  );
}

export async function handleGetTransactionDetails(deps: ToolDeps, input: unknown): Promise<CallToolResult> {
  const startedAt = Date.now();
  const parsed = getTransactionDetailsInput.safeParse(input);
  if (!parsed.success) {
    return finishToolError(deps.log, startedAt, validationMessage(parsed.error), { outcome: "invalid-input" });
  }
  const log = deps.log.child({ tool: "getTransactionDetails" });
  log.info({}, "getTransactionDetails started");
  if (!deps.source.ok) {
    return finishToolError(log, startedAt, configurationProblems(deps.source.problems), { problems: deps.source.problems.length });
  }
  if (deps.reader === null) {
    return finishToolError(log, startedAt, "Transaction reader is unavailable.", { outcome: "reader-unavailable" });
  }

  return executeDetails({ source: deps.source, input: parsed.data, startedAt, log, reader: deps.reader });
}

type ExecuteDetailsOptions = {
  readonly source: Extract<ToolDeps["source"], { readonly ok: true }>;
  readonly input: GetTransactionDetailsInput;
  readonly startedAt: number;
  readonly log: ToolDeps["log"];
  readonly reader: NonNullable<ToolDeps["reader"]>;
};

async function executeDetails(options: ExecuteDetailsOptions): Promise<CallToolResult> {
  const { source, input, startedAt, log, reader } = options;
  try {
    const loaded = await reader.load(source.connections);
    const unavailable = unavailableConnections(loaded.unavailable);
    if (unavailable !== null) {
      return finishToolError(log, startedAt, unavailable.message, unavailable.fields);
    }
    const rows = reader.byIds(input.ids);
    const missing = input.ids.filter((id) => !rows.some((row) => row.id === id));
    if (missing.length > 0) {
      return finishToolError(log, startedAt, `Unknown transaction id(s): ${missing.join(", ")}.`, { missing });
    }
    const byId = new Map(rows.map((row) => [row.id, row]));
    const transactions = input.ids.map((id) => formatDetail(rowForId(byId, id)));
    log.info({ durationMs: Date.now() - startedAt, outcome: "ok", rows: transactions.length }, "getTransactionDetails finished");
    return textResult({ transactions });
  } catch (error) {
    return finishToolError(log, startedAt, `Cannot read transaction details: ${messageOf(error)}`, { outcome: "failure" });
  }
}

function unavailableConnections(
  unavailable: readonly { readonly connectionId: string; readonly kind: string; readonly message: string }[],
): { readonly message: string; readonly fields: Readonly<Record<string, unknown>> } | null {
  if (unavailable.length === 0) {
    return null;
  }
  const connections = unavailable.map(({ connectionId }) => connectionId).join(", ");
  return {
    message: `Cannot read transaction details because these connections are unavailable: ${connections}.`,
    fields: { unavailable: unavailable.length },
  };
}

function rowForId(rows: ReadonlyMap<string, Transaction>, id: string): Transaction {
  const row = rows.get(id);
  if (row === undefined) {
    throw new Error(`transaction ${id} disappeared during detail lookup`);
  }
  return row;
}

function formatDetail(row: Transaction): unknown {
  return {
    id: row.id,
    accountId: row.accountId,
    accountType: row.accountType,
    accountSubtype: row.accountSubtype,
    date: row.localDate,
    occurredAt: row.occurredAt,
    description: row.description,
    descriptionNorm: row.descriptionNorm,
    amount: toDecimal(row.amountCents),
    currency: row.currency,
    original: formatOriginal(row),
    categoryId: row.categoryId,
    counterparty: formatCounterparty(row),
    paymentMethod: row.paymentMethod,
    instalment: formatInstalment(row),
    purchaseDate: row.purchaseDate,
    mcc: row.mcc,
    billId: row.billId,
  };
}

function formatOriginal(row: Transaction): { readonly amount: string; readonly currency: string } | undefined {
  if (row.originalAmountCents === null || row.originalCurrency === null) {
    return undefined;
  }
  return { amount: toDecimal(row.originalAmountCents), currency: row.originalCurrency };
}

function formatCounterparty(row: Transaction): { readonly document?: string; readonly name?: string } | undefined {
  if (row.document === null && row.counterpartyName === null) {
    return undefined;
  }
  const details: { document?: string; name?: string } = {};
  if (row.document !== null) {
    details.document = row.document;
  }
  if (row.counterpartyName !== null) {
    details.name = row.counterpartyName;
  }
  return details;
}

function formatInstalment(row: Transaction): { readonly number?: number; readonly total?: number } | undefined {
  if (row.instalmentNumber === null && row.instalmentTotal === null) {
    return undefined;
  }
  const details: { number?: number; total?: number } = {};
  if (row.instalmentNumber !== null) {
    details.number = row.instalmentNumber;
  }
  if (row.instalmentTotal !== null) {
    details.total = row.instalmentTotal;
  }
  return details;
}

function validationMessage(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) {
    return "Invalid transaction ids.";
  }
  return `Invalid transaction ids: ${issue.path.join(".") || "input"} ${issue.message}.`;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

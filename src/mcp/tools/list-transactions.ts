import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { buildRollup } from "../../core/taxonomy.ts";
import { isCategoryId } from "../../core/category.ts";
import type { TransactionFilter } from "../../core/contracts.ts";
import type { Transaction } from "../../core/transaction.ts";
import { decodeCursor, encodeCursor } from "../cursor.ts";
import { toDecimal } from "../format.ts";
import { configurationProblems, finishToolError, textResult, type ToolDeps } from "./result.ts";
import { validateRange, validationMessage, toTransactionFilter } from "./transaction-input.ts";

const dateInput = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, "must be YYYY-MM-DD");
const categoryInput = z.string().refine(isCategoryId, "must be a known category id");
const listTransactionsInput = z.object({
  startDate: dateInput,
  endDate: dateInput,
  categories: z.array(categoryInput).optional(),
  minAmountCents: z.number().int().optional(),
  maxAmountCents: z.number().int().optional(),
  accountType: z.enum(["BANK", "CREDIT", "INVESTMENT", "LOAN"]).optional(),
  accountSubtype: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(100),
  cursor: z.string().optional(),
}).superRefine(validateRange);

type ListTransactionsInput = z.infer<typeof listTransactionsInput>;

export const LIST_TRANSACTIONS_DESCRIPTION = `Lists individual transactions over a date range with a bounded page size.

Use this tool when:
- You need the descriptions, amounts and ids behind an aggregate.
- You need to inspect a page of matching transactions before requesting details.
- You need to continue through a large result set with the returned cursor.

Returns: Up to 100 transactions ordered newest first, with a cursor when more rows remain. The cursor belongs to the exact filters used for the request. If a connection is unavailable, available rows are returned with an explicit notice.`;

export function registerListTransactions(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "listTransactions",
    { description: LIST_TRANSACTIONS_DESCRIPTION, inputSchema: listTransactionsInput },
    async (input) => handleListTransactions(deps, input),
  );
}

export async function handleListTransactions(deps: ToolDeps, input: unknown): Promise<CallToolResult> {
  const startedAt = Date.now();
  const parsed = listTransactionsInput.safeParse(input);
  if (!parsed.success) {
    return finishToolError(deps.log, startedAt, validationMessage(parsed.error), { outcome: "invalid-input" });
  }
  const log = deps.log.child({ tool: "listTransactions" });
  log.info({}, "listTransactions started");
  if (!deps.source.ok) {
    return finishToolError(log, startedAt, configurationProblems(deps.source.problems), { problems: deps.source.problems.length });
  }
  if (deps.reader === null) {
    return finishToolError(log, startedAt, "Transaction reader is unavailable.", { outcome: "reader-unavailable" });
  }
  return executeListTransactions({ deps, input: parsed.data, startedAt, log, reader: deps.reader });
}

type ExecuteListOptions = {
  readonly deps: ToolDeps;
  readonly input: ListTransactionsInput;
  readonly startedAt: number;
  readonly log: ToolDeps["log"];
  readonly reader: NonNullable<ToolDeps["reader"]>;
};

async function executeListTransactions(options: ExecuteListOptions): Promise<CallToolResult> {
  const { deps, input, startedAt, log, reader } = options;
  if (!deps.source.ok) {
    return finishToolError(log, startedAt, configurationProblems(deps.source.problems), { problems: deps.source.problems.length });
  }
  try {
    const loaded = await reader.load(deps.source.connections);
    const filter = toTransactionFilter(input, loaded.accounts);
    const after = cursorPosition(input.cursor, filter);
    if (after.error !== null) {
      return finishToolError(log, startedAt, after.error, { outcome: "invalid-cursor" });
    }
    const rows = reader.query(addPage(filter, input.limit, after.position));
    const taxonomy = buildRollup(await deps.source.bank.getCategories());
    const response = formatListResponse({ rows, limit: input.limit, filter, taxonomy, unavailable: loaded.unavailable });
    log.info({ durationMs: Date.now() - startedAt, outcome: "ok", rows: rows.length }, "listTransactions finished");
    return textResult(response);
  } catch (error) {
    return finishToolError(log, startedAt, `Cannot list transactions: ${messageOf(error)}`, { outcome: "failure" });
  }
}

function cursorPosition(cursor: string | undefined, filter: TransactionFilter): {
  readonly position?: { readonly localDate: string; readonly id: string };
  readonly error: string | null;
} {
  if (cursor === undefined) {
    return { error: null };
  }
  const decoded = decodeCursor(cursor, filter);
  if (!decoded.ok) {
    return { error: `Invalid transaction cursor: ${decoded.message}.` };
  }
  return { position: decoded.position, error: null };
}

function addPage(filter: TransactionFilter, limit: number, after: { readonly localDate: string; readonly id: string } | undefined): TransactionFilter {
  if (after === undefined) {
    return { ...filter, limit: limit + 1 };
  }
  return { ...filter, limit: limit + 1, after };
}

type FormatListOptions = {
  readonly rows: readonly Transaction[];
  readonly limit: number;
  readonly filter: TransactionFilter;
  readonly taxonomy: ReadonlyMap<string, string>;
  readonly unavailable: readonly { readonly connectionId: string; readonly kind: string; readonly message: string }[];
};

function formatListResponse(options: FormatListOptions): unknown {
  const page = options.rows.slice(0, options.limit);
  let cursor: string | undefined;
  if (options.rows.length > options.limit) {
    const last = page.at(-1);
    if (last !== undefined) {
      cursor = encodeCursor({ localDate: last.localDate, id: last.id }, options.filter);
    }
  }
  let notice: string | undefined;
  if (options.unavailable.length > 0) {
    notice = `Some connections were unavailable: ${options.unavailable.map(({ connectionId }) => connectionId).join(", ")}.`;
  }
  return {
    transactions: page.map((row) => formatListRow(row, options.taxonomy)),
    cursor,
    notice,
  };
}

function formatListRow(row: Transaction, taxonomy: ReadonlyMap<string, string>): unknown {
  let category: string | null = null;
  if (row.categoryId !== null) {
    const root = taxonomy.get(row.categoryId);
    if (root === undefined) {
      throw new Error(`category ${row.categoryId} is not in the fetched taxonomy`);
    }
    category = root;
  }
  return { id: row.id, date: row.localDate, descriptionNorm: row.descriptionNorm, amount: toDecimal(row.amountCents), category };
}

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

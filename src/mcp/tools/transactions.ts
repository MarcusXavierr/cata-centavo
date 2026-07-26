import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { aggregate, type Aggregate, type CategoryGroup } from "../../core/aggregate.ts";
import type { Account } from "../../core/account.ts";
import { categoryById, isCategoryId } from "../../core/category.ts";
import { todayIn } from "../../core/date.ts";
import { buildRollup } from "../../core/taxonomy.ts";
import type { TransactionFilter } from "../../core/contracts.ts";
import { toDecimal } from "../format.ts";
import type { Source } from "../source.ts";
import { configurationProblems, finishToolError, textResult, type ToolDeps } from "./result.ts";

export { handleListTransactions, registerListTransactions, LIST_TRANSACTIONS_DESCRIPTION } from "./list-transactions.ts";

export const GET_TRANSACTIONS_DESCRIPTION = `Totals spending and income over a date range, grouped by category.

Use this tool when:
- You need to know how much was spent in a period, overall or in one category.
- You need to compare categories or periods against each other.
- You need transaction ids to look at individual rows afterwards.

Returns: \`spent\` and \`received\` as positive amounts, and one group per category with a signed total, a count and up to ten sample ids. Transfers between the user's own accounts and credit card bill payments are listed as groups but excluded from \`spent\` and \`received\`, because moving money between your own accounts is not spending. Instalments dated in the future are reported separately as \`upcoming\`. \`dataThrough\` states the most recent date each connection has actually supplied, which can trail its last sync by weeks.`;

const dateInput = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, "must be YYYY-MM-DD");
const categoryInput = z.string().refine(isCategoryId, "must be a known category id");
const getTransactionsInput = z.object({
  startDate: dateInput,
  endDate: dateInput,
  categories: z.array(categoryInput).optional(),
  minAmountCents: z.number().int().optional(),
  maxAmountCents: z.number().int().optional(),
  accountType: z.enum(["BANK", "CREDIT", "INVESTMENT", "LOAN"]).optional(),
  accountSubtype: z.string().min(1).optional(),
}).superRefine(validateRange);

type GetTransactionsInput = z.infer<typeof getTransactionsInput>;

export function registerGetTransactions(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "getTransactions",
    { description: GET_TRANSACTIONS_DESCRIPTION, inputSchema: getTransactionsInput },
    async (input) => handleGetTransactions(deps, input),
  );
}

export async function handleGetTransactions(deps: ToolDeps, input: unknown): Promise<CallToolResult> {
  const startedAt = Date.now();
  const parsed = getTransactionsInput.safeParse(input);
  if (!parsed.success) {
    return finishToolError(deps.log, startedAt, validationMessage(parsed.error), { outcome: "invalid-input" });
  }

  const log = deps.log.child({ tool: "getTransactions" });
  log.info({}, "getTransactions started");
  if (!deps.source.ok) {
    return finishToolError(log, startedAt, configurationProblems(deps.source.problems), { problems: deps.source.problems.length });
  }
  if (deps.reader === null) {
    return finishToolError(log, startedAt, "Transaction reader is unavailable.", { outcome: "reader-unavailable" });
  }

  return executeGetTransactions({ deps, input: parsed.data, startedAt, log, reader: deps.reader });
}

function validateRange(input: { readonly startDate: string; readonly endDate: string }, context: z.RefinementCtx): void {
  if (input.endDate < input.startDate) {
    context.addIssue({ code: "custom", path: ["endDate"], message: "must not be before startDate" });
  }
}

type ExecuteOptions = {
  readonly deps: ToolDeps;
  readonly input: GetTransactionsInput;
  readonly startedAt: number;
  readonly log: ToolDeps["log"];
  readonly reader: NonNullable<ToolDeps["reader"]>;
};

async function executeGetTransactions(options: ExecuteOptions): Promise<CallToolResult> {
  const { deps, input, startedAt, log, reader } = options;
  if (!deps.source.ok) {
    return finishToolError(log, startedAt, configurationProblems(deps.source.problems), { problems: deps.source.problems.length });
  }

  try {
    const loaded = await reader.load(deps.source.connections);
    const unavailable = unavailableRefusal(loaded.unavailable);
    if (unavailable !== null) {
      return finishToolError(log, startedAt, unavailable.message, unavailable.fields);
    }

    const currency = oneCurrency(loaded.accounts);
    if (currency === null) {
      return currencyError(log, startedAt, loaded.accounts);
    }

    const aggregateResult = await readAggregate({ source: deps.source, reader, input, accounts: loaded.accounts, clock: deps.clock });
    const response = formatResponse({ result: aggregateResult.result, input, currency, accounts: loaded.accounts, reader, today: aggregateResult.today });

    log.info({ durationMs: Date.now() - startedAt, outcome: "ok", rows: aggregateResult.rows }, "getTransactions finished");
    return textResult(response);
  } catch (error) {
    return finishToolError(log, startedAt, `Cannot read transactions: ${messageOf(error)}`, { outcome: "failure" });
  }
}

function validationMessage(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) {
    return "Invalid transaction filters.";
  }
  return `Invalid transaction filters: ${issue.path.join(".") || "input"} ${issue.message}.`;
}

function toFilter(input: GetTransactionsInput, accounts: readonly Account[]): TransactionFilter {
  let filter: TransactionFilter = {
    accountIds: accounts.map((account) => account.id),
    from: input.startDate,
    to: input.endDate,
  };
  if (input.categories !== undefined) {
    filter = { ...filter, categories: input.categories };
  }
  if (input.minAmountCents !== undefined) {
    filter = { ...filter, minAmountCents: input.minAmountCents };
  }
  if (input.maxAmountCents !== undefined) {
    filter = { ...filter, maxAmountCents: input.maxAmountCents };
  }
  if (input.accountType !== undefined) {
    filter = { ...filter, accountType: input.accountType };
  }
  if (input.accountSubtype !== undefined) {
    filter = { ...filter, accountSubtype: input.accountSubtype };
  }
  return filter;
}

function oneCurrency(accounts: readonly Account[]): string | null {
  const currencies = currenciesIn(accounts);
  if (currencies.length !== 1) {
    return null;
  }
  const currency = currencies[0];
  if (currency === undefined) {
    return null;
  }
  return currency;
}

function currenciesIn(accounts: readonly Account[]): readonly string[] {
  return [...new Set(accounts.map((account) => account.currency))].sort();
}

function currencyError(log: ToolDeps["log"], startedAt: number, accounts: readonly Account[]): CallToolResult {
  const currencies = currenciesIn(accounts);
  return finishToolError(log, startedAt, `Cannot consolidate transactions across currencies: ${currencies.join(", ")}.`, { currencies });
}

function unavailableRefusal(
  unavailable: readonly { readonly connectionId: string; readonly kind: string; readonly message: string }[],
): { readonly message: string; readonly fields: Readonly<Record<string, unknown>> } | null {
  if (unavailable.length === 0) {
    return null;
  }
  return {
    message: `Cannot read transactions because ${unavailable
      .map(({ connectionId, kind, message }) => `${connectionId} (${kind}): ${message}`)
      .join("; ")}`,
    fields: { unavailable: unavailable.length },
  };
}

type AggregateOptions = {
  readonly source: Extract<Source, { readonly ok: true }>;
  readonly reader: NonNullable<ToolDeps["reader"]>;
  readonly input: GetTransactionsInput;
  readonly accounts: readonly Account[];
  readonly clock: ToolDeps["clock"];
};

type AggregateResult = {
  readonly result: Aggregate;
  readonly rows: number;
  readonly today: string;
};

async function readAggregate(options: AggregateOptions): Promise<AggregateResult> {
  const filter = toFilter(options.input, options.accounts);
  const rows = options.reader.query(filter);
  const taxonomy = buildRollup(await options.source.bank.getCategories());
  const today = todayIn(options.clock);
  return { result: aggregate(rows, taxonomy, today), rows: rows.length, today };
}

type FormatResponseOptions = {
  readonly result: Aggregate;
  readonly input: GetTransactionsInput;
  readonly currency: string;
  readonly accounts: readonly Account[];
  readonly reader: NonNullable<ToolDeps["reader"]>;
  readonly today: string;
};

function formatResponse(options: FormatResponseOptions): unknown {
  const { result, input, currency, accounts, reader, today } = options;
  let upcomingField: { readonly upcoming: { readonly total: string; readonly count: number } } | Record<string, never>;
  if (result.upcoming.count === 0) {
    upcomingField = {};
  } else {
    upcomingField = { upcoming: { total: toDecimal(result.upcoming.totalCents), count: result.upcoming.count } };
  }

  return {
    from: input.startDate,
    to: input.endDate,
    currency,
    spent: toDecimal(result.spentCents),
    received: toDecimal(result.receivedCents),
    groups: result.groups.map(formatGroup),
    ...upcomingField,
    accountsCovered: accounts.length,
    dataThrough: [...reader.dataThrough(accounts.map((account) => account.id), today)].map(([connectionId, through]) => ({ connectionId, through })),
  };
}

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function formatGroup(group: CategoryGroup): unknown {
  let label = "Uncategorized";
  if (group.categoryId !== null) {
    const category = categoryById(group.categoryId);
    if (category === undefined) {
      throw new Error(`category ${group.categoryId} is not in the display taxonomy`);
    }
    label = category.pt;
  }
  return {
    category: group.categoryId,
    label,
    total: toDecimal(group.totalCents),
    count: group.count,
    sampleIds: group.sampleIds,
  };
}

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { ACCOUNT_TYPES, type Account } from "../../core/account.ts";
import { identifyOpenCycle } from "../../core/bill.ts";
import type { ClosingDay, Logger } from "../../core/contracts.ts";
import { todayIn } from "../../core/date.ts";
import { deriveInstalmentPlans } from "../../core/instalment-plans.ts";
import type { TransactionReader } from "../../core/transactions.ts";
import type { Source } from "../source.ts";
import { configurationProblems, finishToolError, textResult, type ToolDeps } from "./result.ts";
import { serializeResponse, type CardPlans } from "./instalment-plans-format.ts";

export const LIST_INSTALMENT_PLANS_DESCRIPTION = `Lists credit card purchases still being paid in instalments.

Use this tool when:
- The user asks what they are still paying off, or when a purchase finishes.
- You need committed future spending before judging whether a new purchase fits.
- You need to explain why a card's used credit exceeds its current bill.

Returns: One entry per plan with the merchant, what the purchase cost, the per-instalment amount, instalments paid and remaining, the money still owed, and the cycle the last instalment lands on. Each of those is marked reported when the bank published the underlying rows, and estimated or derived when it was projected from the instalments that did arrive; an estimate can be a centavo either side of the truth. A missing purchase total means the cache does not reach back to the first instalment. Cycles are the month a bill falls due. Open plans only unless includeSettled is set.`;

const listInstalmentPlansSchema = z.object({
  accountId: z.string().min(1).optional(),
  connectionId: z.string().min(1).optional(),
  includeSettled: z.boolean().default(false),
});

type ListInstalmentPlansInput = z.infer<typeof listInstalmentPlansSchema>;

type ReadySource = Extract<Source, { readonly ok: true }>;

/** The parsed input and the narrowed dependencies every later step needs. */
type Prepared =
  | {
      readonly ok: true;
      readonly input: ListInstalmentPlansInput;
      readonly source: ReadySource;
      readonly reader: TransactionReader;
    }
  | { readonly ok: false; readonly result: CallToolResult };

type CardSelection =
  | { readonly ok: true; readonly cards: readonly Account[] }
  | { readonly ok: false; readonly result: CallToolResult };

type CardSelectionOptions = {
  readonly accounts: readonly Account[];
  readonly accountId: string | undefined;
  readonly log: Logger;
  readonly startedAt: number;
};

type CardPlansOptions = {
  readonly source: ReadySource;
  readonly reader: TransactionReader;
  readonly account: Account;
  readonly closingDays: readonly ClosingDay[];
  readonly today: string;
};

const TOOL = "listInstalmentPlans";

export function registerListInstalmentPlans(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "listInstalmentPlans",
    { description: LIST_INSTALMENT_PLANS_DESCRIPTION, inputSchema: listInstalmentPlansSchema },
    async (input) => handleListInstalmentPlans(deps, input),
  );
}

export async function handleListInstalmentPlans(deps: ToolDeps, rawInput: unknown): Promise<CallToolResult> {
  const startedAt = Date.now();
  const prepared = prepare(deps, rawInput, startedAt);
  if (!prepared.ok) {
    return prepared.result;
  }

  const { input, source, reader } = prepared;
  const connectionIds = connectionsToLoad(source, input.connectionId);
  const loaded = await reader.load(connectionIds);
  const selection = selectCards({
    accounts: loaded.accounts,
    accountId: input.accountId,
    log: deps.log,
    startedAt,
  });
  if (!selection.ok) {
    return selection.result;
  }

  const today = todayIn(deps.clock);
  const closingDays = deps.closingDays?.list() ?? [];
  const derivations = await Promise.all(
    selection.cards.map((account) => plansForCard({ source, reader, account, closingDays, today })),
  );
  const response = serializeResponse({
    derivations,
    includeSettled: input.includeSettled,
    accountIds: selection.cards.map(({ id }) => id),
    reader,
    today,
    unavailable: loaded.unavailable,
    connectionId: input.connectionId,
    connectionIds,
  });

  return textResult(response);
}


/** Parse the input and narrow the dependencies the handler cannot work without. */
function prepare(deps: ToolDeps, rawInput: unknown, startedAt: number): Prepared {
  const parsed = listInstalmentPlansSchema.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, result: finishToolError(deps.log, startedAt, parsed.error.message, { tool: TOOL }) };
  }
  const source = deps.source;
  if (!source.ok) {
    return {
      ok: false,
      result: finishToolError(deps.log, startedAt, configurationProblems(source.problems), { tool: TOOL }),
    };
  }
  const reader = deps.reader;
  if (reader === null) {
    return {
      ok: false,
      result: finishToolError(deps.log, startedAt, "Transaction reader is unavailable.", { tool: TOOL }),
    };
  }
  return { ok: true, input: parsed.data, source, reader };
}

/**
 * An unknown `connectionId` narrows to nothing rather than to every connection:
 * loading the lot would answer a question the caller did not ask. The empty
 * load is what earns the readable notice further down.
 */
function connectionsToLoad(source: ReadySource, connectionId: string | undefined): readonly string[] {
  if (connectionId === undefined) {
    return source.connections;
  }
  if (source.connections.includes(connectionId)) {
    return [connectionId];
  }
  return [];
}

/**
 * Credit cards only. A named `accountId` that resolves to something else is a
 * caller mistake worth reporting, not an empty result worth guessing at.
 */
function selectCards(options: CardSelectionOptions): CardSelection {
  const { accounts, accountId, log, startedAt } = options;
  const cards = accounts.filter((account) => account.type === ACCOUNT_TYPES.credit);
  if (accountId === undefined) {
    return { ok: true, cards };
  }
  const selected = accounts.find((account) => account.id === accountId);
  if (selected === undefined) {
    return {
      ok: false,
      result: finishToolError(log, startedAt, `Unknown account ${accountId}: not found.`, { tool: TOOL, accountId }),
    };
  }
  if (selected.type !== ACCOUNT_TYPES.credit) {
    return { ok: false, result: notACreditCard(log, startedAt, selected) };
  }
  return { ok: true, cards: cards.filter((account) => account.id === accountId) };
}

function notACreditCard(log: Logger, startedAt: number, account: Account): CallToolResult {
  let actualType: string = account.type;
  if (account.subtype !== null) {
    actualType = `${account.type} (${account.subtype})`;
  }
  return finishToolError(
    log,
    startedAt,
    `Account ${account.id} has type ${actualType}; ${TOOL} requires a CREDIT card.`,
    {
      tool: TOOL,
      accountId: account.id,
      accountType: account.type,
      accountSubtype: account.subtype,
    },
  );
}

/** One card's plans: its bills, the cycle currently open, and the rows it owns. */
async function plansForCard(options: CardPlansOptions): Promise<CardPlans> {
  const { source, reader, account, closingDays, today } = options;
  const { storedDay, balanceDueDate } = cycleBoundaries(account, closingDays);
  const bills = await source.bank.getBills(account);
  const openCycle = identifyOpenCycle(bills, storedDay, balanceDueDate, today);
  const rows = reader.cardRows(account.id);
  const derivation = deriveInstalmentPlans({
    rows,
    bills,
    openCycle: openCycle?.openCycle ?? null,
    today,
  });
  return { account, derivation, openCycle: openCycle?.openCycle ?? null };
}


type CycleBoundaries = {
  readonly storedDay: number | null;
  readonly balanceDueDate: string | null;
};

/**
 * The two nullable edges `identifyOpenCycle` reads for a card: the closing day
 * the caller stored for it, and the bank's own due date for the open balance
 * reduced to the plain `YYYY-MM-DD` day the cycle logic compares against.
 * Either is absent whenever nothing was stored and the bank published nothing.
 */
function cycleBoundaries(account: Account, closingDays: readonly ClosingDay[]): CycleBoundaries {
  const storedDay = closingDays.find((entry) => entry.accountId === account.id)?.day ?? null;
  const balanceDueDate = account.credit?.balanceDueDate?.toISOString().slice(0, 10) ?? null;
  return { storedDay, balanceDueDate };
}


import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { ACCOUNT_TYPES, type Account } from "../../core/account.ts";
import {
  ClosingDateSource,
  deriveBillCommitment,
  derivePostedCents,
  identifyOpenCycle,
  partitionBillRows,
  type Bill,
  type OpenCycle,
} from "../../core/bill.ts";
import type { ClosingDayStore, Logger } from "../../core/contracts.ts";
import { localDayOf, todayIn } from "../../core/date.ts";
import { isSelfTransfer } from "../../core/self-transfer.ts";
import type { DerivedTransaction } from "../../core/transaction.ts";
import type { TransactionReader } from "../../core/transactions.ts";
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

type BillSummaryExecution = {
  readonly deps: ToolDeps;
  readonly source: Extract<Source, { readonly ok: true }>;
  readonly reader: TransactionReader;
  readonly account: Account;
  readonly startedAt: number;
};

async function executeBillSummary(options: BillSummaryExecution): Promise<CallToolResult> {
  const { deps, source, reader, account: resolvedAccount, startedAt } = options;
  const loaded = await reader.load([resolvedAccount.connectionId]);
  const unavailable = unavailableFor(loaded.unavailable, resolvedAccount.connectionId);
  const refusal = unavailableResult(unavailable, resolvedAccount, deps.log, startedAt);
  if (refusal !== null) {
    return refusal;
  }

  const account = loaded.accounts.find(({ id }) => id === resolvedAccount.id) ?? resolvedAccount;
  return summarizeCachedCard({ deps, source, reader, account });
}

type CachedCardSummary = {
  readonly deps: ToolDeps;
  readonly source: Extract<Source, { readonly ok: true }>;
  readonly reader: TransactionReader;
  readonly account: Account;
};

async function summarizeCachedCard(options: CachedCardSummary): Promise<CallToolResult> {
  const { deps, source, reader, account } = options;
  const rows = reader.cardRows(account.id);
  const base = formatSummaryBase(account);
  if (rows.length === 0) {
    return textResult({
      ...base,
      message: "This card has never been synced, or its latest sync returned no cached transactions.",
    });
  }

  const today = todayIn(deps.clock);
  const dataThrough = reader.dataThrough([account.id], today).get(account.connectionId);
  if (dataThrough === undefined) {
    return textResult({
      ...base,
      message: "No cached transaction date is available through today, so bill figures were omitted.",
    });
  }

  return summarizeDatedCard({ deps, source, account, rows, base, today, dataThrough });
}

type DatedCardSummary = {
  readonly deps: ToolDeps;
  readonly source: Extract<Source, { readonly ok: true }>;
  readonly account: Account;
  readonly rows: readonly DerivedTransaction[];
  readonly base: Readonly<Record<string, unknown>>;
  readonly today: string;
  readonly dataThrough: string;
};

async function summarizeDatedCard(options: DatedCardSummary): Promise<CallToolResult> {
  const { deps, source, account, rows, base, today, dataThrough } = options;
  const bills = await source.bank.getBills(account);
  const storedDay = storedClosingDay(deps.closingDays, account.id);
  const balanceDueDate = dateOnly(account.credit?.balanceDueDate ?? null);
  const openCycle = identifyOpenCycle(bills, storedDay, balanceDueDate, today);
  const freshness = {
    dataThrough,
    staleDays: staleDays(account.lastUpdatedAt, dataThrough),
  };
  if (openCycle === null) {
    return textResult({
      ...base,
      ...freshness,
      message: "The open cycle cannot be identified. Use setClosingDay for this card.",
    });
  }

  return textResult({
    ...base,
    cycle: formatCycle(openCycle, bills, account, storedDay),
    ...formatDerivedFigures(account, rows, bills, openCycle),
    ...freshness,
  });
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

function formatSummaryBase(account: Account): Readonly<Record<string, unknown>> {
  return {
    accountId: account.id,
    institution: account.institution,
    currency: account.currency,
    utilization: toDecimal(account.amountCents),
    creditLimit: decimalOrNull(account.credit?.limitCents ?? null),
    availableLimit: decimalOrNull(account.credit?.availableLimitCents ?? null),
  };
}

function formatDerivedFigures(
  account: Account,
  rows: readonly DerivedTransaction[],
  bills: readonly Bill[],
  openCycle: OpenCycle,
): Readonly<Record<string, unknown>> {
  let openBillId: string | null = null;
  if (openCycle.source === ClosingDateSource.openBill) {
    openBillId = newestBill(bills)?.id ?? null;
  }
  const partition = partitionBillRows(rows, openCycle.openCycle, openBillId);
  const postedCents = derivePostedCents(partition.openCycleRows);
  const commitment = deriveBillCommitment(partition, account.amountCents);

  return {
    posted: toDecimal(postedCents),
    committed: toDecimal(commitment.committedCents),
    futureInstalments: toDecimal(commitment.futureCents),
    gap: toDecimal(Math.abs(commitment.committedCents - postedCents)),
    committedIsNegative: commitment.committedCents < 0,
    postedExceedsCommitted: postedCents > commitment.committedCents,
    topTransactions: topTransactions(partition.openCycleRows),
  };
}

function topTransactions(rows: readonly DerivedTransaction[]): readonly unknown[] {
  return rows
    .filter((row) => row.amountCents < 0 && !isSelfTransfer(row))
    .toSorted(compareCharges)
    .slice(0, 5)
    .map((row) => ({
      id: row.id,
      date: row.localDate,
      description: row.description,
      amount: toDecimal(-row.amountCents),
      category: row.category,
    }));
}

function compareCharges(left: DerivedTransaction, right: DerivedTransaction): number {
  const amountOrder = left.amountCents - right.amountCents;
  if (amountOrder !== 0) {
    return amountOrder;
  }
  const dateOrder = right.localDate.localeCompare(left.localDate);
  if (dateOrder !== 0) {
    return dateOrder;
  }
  return left.id.localeCompare(right.id);
}

function formatCycle(
  openCycle: OpenCycle,
  bills: readonly Bill[],
  account: Account,
  storedDay: number | null,
): Readonly<Record<string, unknown>> {
  const dates = cycleDates(openCycle, bills, account, storedDay);
  return {
    openCycle: openCycle.openCycle,
    ...dates,
    closingDateSource: openCycle.source,
  };
}

type CycleDates = {
  readonly closingDate: string | null;
  readonly dueDate: string | null;
};

function cycleDates(
  openCycle: OpenCycle,
  bills: readonly Bill[],
  account: Account,
  storedDay: number | null,
): CycleDates {
  const latestBill = newestBill(bills);
  if (openCycle.source === ClosingDateSource.openBill) {
    return datesFromOpenBill(latestBill);
  }
  if (openCycle.source === ClosingDateSource.lastClosed) {
    return datesAfterClosedBill(latestBill);
  }
  if (openCycle.source === ClosingDateSource.local) {
    return datesFromLocalDay(openCycle.openCycle, storedDay, account);
  }
  return {
    closingDate: dateInCycleFrom(creditDate(account, "balanceCloseDate"), openCycle.openCycle),
    dueDate: dateInCycleFrom(creditDate(account, "balanceDueDate"), openCycle.openCycle),
  };
}

function datesFromOpenBill(bill: Bill | null): CycleDates {
  if (bill === null) {
    return { closingDate: null, dueDate: null };
  }
  return { closingDate: bill.closingDate, dueDate: bill.dueDate };
}

function datesAfterClosedBill(bill: Bill | null): CycleDates {
  if (bill === null) {
    return { closingDate: null, dueDate: null };
  }
  return {
    closingDate: shiftOneMonth(bill.closingDate),
    dueDate: shiftOneMonth(bill.dueDate),
  };
}

function datesFromLocalDay(cycle: string, storedDay: number | null, account: Account): CycleDates {
  let closingDate: string | null = null;
  if (storedDay !== null) {
    closingDate = dateInCycle(cycle, storedDay);
  }
  return {
    closingDate,
    dueDate: dateInCycleFrom(creditDate(account, "balanceDueDate"), cycle),
  };
}

function newestBill(bills: readonly Bill[]): Bill | null {
  let newest: Bill | null = null;
  for (const candidate of bills) {
    if (newest === null || billDate(candidate) > billDate(newest)) {
      newest = candidate;
    }
  }
  return newest;
}

function billDate(bill: Bill): string {
  if (bill.closingDate !== null) {
    return bill.closingDate;
  }
  return bill.dueDate;
}

function creditDate(
  account: Account,
  field: "balanceCloseDate" | "balanceDueDate",
): Date | null {
  if (account.credit === null) {
    return null;
  }
  return account.credit[field];
}

function storedClosingDay(store: ClosingDayStore | null | undefined, accountId: string): number | null {
  if (store === null || store === undefined) {
    return null;
  }
  return store.list().find((entry) => entry.accountId === accountId)?.day ?? null;
}

function unavailableFor(
  unavailable: readonly { readonly connectionId: string; readonly kind: string; readonly message: string }[],
  connectionId: string,
): { readonly connectionId: string; readonly kind: string; readonly message: string } | null {
  return unavailable.find((candidate) => candidate.connectionId === connectionId) ?? null;
}

function unavailableResult(
  unavailable: { readonly connectionId: string; readonly kind: string; readonly message: string } | null,
  account: Account,
  log: Logger,
  startedAt: number,
): CallToolResult | null {
  if (unavailable === null) {
    return null;
  }
  if (!isReadableUnavailable(unavailable.kind)) {
    throw new Error(unavailable.message);
  }
  return finishToolError(log, startedAt, unavailable.message, {
    tool: "getBillSummary",
    accountId: account.id,
    connectionId: unavailable.connectionId,
    kind: unavailable.kind,
  });
}

function isReadableUnavailable(kind: string): boolean {
  return kind === "consent-revoked"
    || kind === "consent-expired"
    || kind === "unknown-connection"
    || kind === "no-accounts";
}

function decimalOrNull(cents: number | null): string | null {
  if (cents === null) {
    return null;
  }
  return toDecimal(cents);
}

function dateOnly(date: Date | null): string | null {
  return date?.toISOString().slice(0, 10) ?? null;
}

function staleDays(lastUpdatedAt: Date | null, dataThrough: string): number | null {
  if (lastUpdatedAt === null) {
    return null;
  }
  const updatedDay = localDayOf(lastUpdatedAt.toISOString());
  const milliseconds = Date.parse(`${updatedDay}T00:00:00.000Z`) - Date.parse(`${dataThrough}T00:00:00.000Z`);
  return Math.max(0, Math.trunc(milliseconds / 86_400_000));
}

function shiftOneMonth(date: string | null): string | null {
  if (date === null) {
    return null;
  }
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  let shiftedYear = year;
  let shiftedMonth = month + 1;
  if (shiftedMonth === 13) {
    shiftedYear += 1;
    shiftedMonth = 1;
  }
  return dateFromParts(shiftedYear, shiftedMonth, day);
}

function dateInCycleFrom(date: Date | null, cycle: string): string | null {
  if (date === null) {
    return null;
  }
  return dateInCycle(cycle, date.getUTCDate());
}

function dateInCycle(cycle: string, day: number): string {
  const year = Number(cycle.slice(0, 4));
  const month = Number(cycle.slice(5, 7));
  return dateFromParts(year, month, day);
}

function dateFromParts(year: number, month: number, day: number): string {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const clampedDay = Math.min(day, lastDay);
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(clampedDay).padStart(2, "0")}`;
}

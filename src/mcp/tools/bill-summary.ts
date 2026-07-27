import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { Account } from "../../core/account.ts";
import type { UnavailableConnection } from "../../core/accounts.ts";
import { identifyOpenCycle } from "../../core/bill.ts";
import type { ClosingDayStore, Logger } from "../../core/contracts.ts";
import { localDayOf, todayIn } from "../../core/date.ts";
import type { DerivedTransaction } from "../../core/transaction.ts";
import type { TransactionReader } from "../../core/transactions.ts";
import type { Source } from "../source.ts";
import { formatCycle, formatDerivedFigures, formatSummaryBase } from "./bill-summary-format.ts";
import { finishToolError, textResult, type ToolDeps } from "./result.ts";

type OkSource = Extract<Source, { readonly ok: true }>;

export type BillSummaryExecution = {
  readonly deps: ToolDeps;
  readonly source: OkSource;
  readonly reader: TransactionReader;
  readonly account: Account;
  readonly startedAt: number;
};

/** Refreshes the card's connection, then reports whatever the cache can support. */
export async function executeBillSummary(options: BillSummaryExecution): Promise<CallToolResult> {
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
  readonly source: OkSource;
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
  readonly source: OkSource;
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

function storedClosingDay(store: ClosingDayStore | null | undefined, accountId: string): number | null {
  if (store === null || store === undefined) {
    return null;
  }
  return store.list().find((entry) => entry.accountId === accountId)?.day ?? null;
}

function unavailableFor(
  unavailable: readonly UnavailableConnection[],
  connectionId: string,
): UnavailableConnection | null {
  return unavailable.find((candidate) => candidate.connectionId === connectionId) ?? null;
}

/**
 * Only the failures the model can act on become readable content. Anything else
 * throws, because a protocol error is the channel a human reads.
 */
function unavailableResult(
  unavailable: UnavailableConnection | null,
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

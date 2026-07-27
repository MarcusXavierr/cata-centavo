import { collectAccounts, type UnavailableConnection } from "./accounts.ts";
import type { Account } from "./account.ts";
import type { Bank, BankFailure, Clock, Logger, TransactionFilter, TransactionStore } from "./contracts.ts";
import type { DerivedTransaction } from "./transaction.ts";

/** The reader's infrastructure dependencies, supplied by the composition root. */
export type TransactionReaderOptions = {
  readonly bank: Bank;
  readonly store: TransactionStore;
  readonly toFailure: (error: unknown) => BankFailure;
  readonly log: Logger;
  readonly clock: Clock;
};

/** Accounts and connection failures after freshness has been reconciled. */
export type LoadResult = {
  readonly accounts: readonly Account[];
  readonly unavailable: readonly UnavailableConnection[];
};

/** The read-through cache boundary used by MCP and CLI callers. */
export type TransactionReader = {
  load(connectionIds: readonly string[]): Promise<LoadResult>;
  query(filter: TransactionFilter): readonly DerivedTransaction[];
  byIds(ids: readonly string[]): readonly DerivedTransaction[];
  dataThrough(accountIds: readonly string[], today: string): ReadonlyMap<string, string>;
};

export function createTransactionReader(options: TransactionReaderOptions): TransactionReader {
  const inFlight = new Map<string, Promise<void>>();

  return {
    load: async (connectionIds) => {
      const collected = await collectAccounts(options.bank, connectionIds, options.toFailure, options.clock);
      await Promise.all(collected.accounts.map((account) => walkIfStale(options, inFlight, account)));
      return collected;
    },
    query: (filter) => options.store.query(filter),
    byIds: (ids) => options.store.byIds(ids),
    dataThrough: (accountIds, today) => options.store.dataThrough(accountIds, today),
  };
}

function walkIfStale(
  options: TransactionReaderOptions,
  inFlight: Map<string, Promise<void>>,
  account: Account,
): Promise<void> {
  const existing = inFlight.get(account.id);
  if (existing !== undefined) {
    return existing;
  }
  if (!needsWalk(options.store, account)) {
    return Promise.resolve();
  }

  const walk = performWalk(options, account).finally(() => inFlight.delete(account.id));
  inFlight.set(account.id, walk);
  return walk;
}

function needsWalk(store: TransactionStore, account: Account): boolean {
  const current = freshnessStamp(account);
  if (current === null) {
    return true;
  }
  return store.syncedLastUpdatedAt(account.id) !== current;
}

async function performWalk(options: TransactionReaderOptions, account: Account): Promise<void> {
  const rows = await options.bank.getTransactions(account);
  const deleted = options.store.replaceAccount(account.id, account.connectionId, rows, freshnessStamp(account));
  options.log.info(
    { accountId: account.id, connectionId: account.connectionId, rows: rows.length, deleted },
    "Walked transactions",
  );
}

function freshnessStamp(account: Account): string | null {
  if (account.lastUpdatedAt === null) {
    return null;
  }
  return account.lastUpdatedAt.toISOString();
}

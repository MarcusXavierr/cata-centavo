import type { Account } from "../../src/core/account.ts";
import type { Bank, Connection } from "../../src/core/contracts.ts";
import type { Transaction } from "../../src/core/transaction.ts";
import { AuthError, NotFoundError } from "../../src/pluggy/errors.ts";

export type FakeBankOptions = {
  readonly connections?: readonly Connection[];
  readonly accounts?: Readonly<Record<string, readonly Account[]>>;
  readonly transactions?: Readonly<Record<string, readonly Transaction[]>>;
  /** When set, `verifyCredentials` rejects with an `AuthError` carrying it. */
  readonly credentialsRejected?: string;
  /** Ids that fail with something other than "not found". */
  readonly unreachable?: Readonly<Record<string, Error>>;
};

export type FakeBank = Bank & {
  readonly calls: readonly string[];
};

/**
 * A `Bank` that answers from a fixed list. Unknown ids reject with the real
 * `NotFoundError`, so callers are tested against the same classification they
 * will face in production.
 */
export function fakeBank(options: FakeBankOptions = {}): FakeBank {
  const connections = options.connections ?? [];
  const accounts = options.accounts ?? {};
  const transactions = options.transactions ?? {};
  const unreachable = options.unreachable ?? {};

  const calls: string[] = [];

  function answer(id: string): Connection {
    const found = connections.find((candidate) => candidate.id === id);
    if (found === undefined) {
      throw new NotFoundError("not found — wrong id, or an id from another Pluggy account", 404);
    }

    return found;
  }

  function throwIfUnreachable(id: string): void {
    const failure = unreachable[id];
    if (failure !== undefined) {
      throw failure;
    }
  }

  return {
    calls,

    verifyCredentials: async () => {
      calls.push("verifyCredentials");
      if (options.credentialsRejected !== undefined) {
        throw new AuthError(options.credentialsRejected, 401);
      }
    },

    getConnection: async (id) => {
      calls.push(id);
      throwIfUnreachable(id);
      return answer(id);
    },

    getAccounts: async (connectionId) => {
      calls.push(`getAccounts:${connectionId}`);
      throwIfUnreachable(connectionId);
      answer(connectionId);
      return accounts[connectionId] ?? [];
    },

    getAccount: async (accountId) => {
      calls.push(`getAccount:${accountId}`);
      throwIfUnreachable(accountId);
      const found = Object.values(accounts).flat().find((candidate) => candidate.id === accountId);
      if (found === undefined) {
        throw new NotFoundError("not found — wrong id, or an id from another Pluggy account", 404);
      }

      return found;
    },

    getTransactions: async (account) => {
      calls.push(`transactions:${account.id}`);
      throwIfUnreachable(account.connectionId);
      return transactions[account.id] ?? [];
    },
  };
}


/** A connection in the state a healthy, freshly synced one comes back in. */
export function connection(id: string, overrides: Partial<Connection> = {}): Connection {
  return {
    id,
    institution: "Nubank",
    status: "UPDATED",
    executionStatus: "SUCCESS",
    lastUpdatedAt: new Date("2026-07-25T09:00:00.000Z"),
    parameter: null,
    warnings: [],
    ...overrides,
  };
}

/** An account with a healthy checking-account default. */
export function account(id: string, overrides: Partial<Account> = {}): Account {
  return {
    id,
    connectionId: "conn-1",
    institution: "Nubank",
    name: `Account ${id}`,
    type: "BANK",
    subtype: "CHECKING_ACCOUNT",
    amountCents: 12_345,
    currency: "BRL",
    lastUpdatedAt: new Date("2026-07-25T09:00:00.000Z"),
    credit: null,
    ...overrides,
  };
}

/** Three healthy connections, each with one checking account and one card. */
export function threeConnections(): Required<Pick<FakeBankOptions, "connections" | "accounts">> {
  const connections = [connection("conn-1"), connection("conn-2"), connection("conn-3")];
  const accounts = Object.fromEntries(
    connections.map((candidate, index) => [
      candidate.id,
      [
        account(`acc-${index * 2 + 1}`, { connectionId: candidate.id }),
        account(`acc-${index * 2 + 2}`, {
          connectionId: candidate.id,
          type: "CREDIT",
          subtype: "CREDIT_CARD",
          credit: {
            limitCents: 100_000,
            availableLimitCents: 80_000,
            balanceCloseDate: null,
            balanceDueDate: null,
            brand: "Mastercard",
          },
        }),
      ],
    ]),
  );

  return { connections, accounts };
}

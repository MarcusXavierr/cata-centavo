import type { z } from "zod";

import type { Account } from "../core/account.ts";
import type { Bill } from "../core/bill.ts";
import type { InvestmentPosition } from "../core/investment.ts";
import type { Bank, Connection, Consent } from "../core/contracts.ts";
import { failureFor, parse, readJson, ResponseShapeError } from "./errors.ts";
import { toAccount, toBill, toConnection, toConsent, toInvestment, toTransaction } from "./mapper.ts";
import { createTransport, type TransportOptions } from "./transport.ts";
import { ACCOUNT, ACCOUNT_PAGE, BILL_PAGE, CONSENT_PAGE, INVESTMENT_PAGE, ITEM, TRANSACTION_PAGE } from "./wire.ts";

export type PluggyClientOptions = TransportOptions;

type Getter = <T>(path: string, schema: z.ZodType<T>, describe: string) => Promise<T>;
type InvestmentPage = z.infer<typeof INVESTMENT_PAGE>;

const MAX_TRANSACTION_HOPS = 500;

function createTransactionWalker(get: Getter): (account: Account) => Promise<readonly ReturnType<typeof toTransaction>[]> {
  return async (account) => {
    const transactions: ReturnType<typeof toTransaction>[] = [];
    const seenIds = new Set<string>();
    let query = `?accountId=${encodeURIComponent(account.id)}`;

    for (let hop = 0; hop < MAX_TRANSACTION_HOPS; hop += 1) {
      const page = await get(`/v2/transactions${query}`, TRANSACTION_PAGE, `transactions ${account.id}`);

      for (const row of page.results) {
        if (seenIds.has(row.id)) {
          throw new ResponseShapeError(`Transaction ${row.id} was already seen while walking ${account.id}`);
        }
        seenIds.add(row.id);
        transactions.push(toTransaction(row, account));
      }

      if (page.next === null) {
        return transactions;
      }

      if (page.next === query) {
        throw new ResponseShapeError(`The cursor stopped advancing while walking ${account.id}`);
      }

      query = page.next;
    }

    throw new ResponseShapeError(`Walking ${account.id} exceeded ${MAX_TRANSACTION_HOPS} pages without reaching the end`);
  };
}

function createInvestmentWalker(get: Getter): Bank["getInvestments"] {
  return async (connectionId) => {
    const encodedConnectionId = encodeURIComponent(connectionId);
    const [item, firstPage] = await Promise.all([
      get(`/items/${encodedConnectionId}`, ITEM, `connection ${connectionId}`),
      get(
        `/investments?itemId=${encodedConnectionId}&pageSize=500&page=1`,
        INVESTMENT_PAGE,
        `investments ${connectionId}`,
      ),
    ]);

    validateFirstInvestmentPage(firstPage, connectionId);
    const pages = await Promise.all(
      Array.from({ length: firstPage.totalPages - 1 }, (_, index) =>
        get(
          `/investments?itemId=${encodedConnectionId}&pageSize=500&page=${index + 2}`,
          INVESTMENT_PAGE,
          `investments ${connectionId}`,
        ),
      ),
    );
    validateFollowingInvestmentPages(firstPage, pages, connectionId);

    return mapInvestments([firstPage, ...pages], toConnection(item), connectionId);
  };
}

function validateFirstInvestmentPage(page: InvestmentPage, connectionId: string): void {
  if (page.page !== 1) {
    throw new ResponseShapeError(`Investment page 1 for connection ${connectionId} reported page ${page.page}`);
  }
  if (!Number.isSafeInteger(page.total) || page.total < 0) {
    throw new ResponseShapeError(`Investment page 1 for connection ${connectionId} has an invalid total`);
  }
  if (!Number.isSafeInteger(page.totalPages) || page.totalPages < 1) {
    throw new ResponseShapeError(`Investment page 1 for connection ${connectionId} has an invalid totalPages`);
  }
}

function validateFollowingInvestmentPages(
  firstPage: InvestmentPage,
  pages: readonly InvestmentPage[],
  connectionId: string,
): void {
  for (const [index, page] of pages.entries()) {
    const requestedPage = index + 2;
    if (page.page !== requestedPage) {
      throw new ResponseShapeError(
        `Investment page ${requestedPage} for connection ${connectionId} reported page ${page.page}`,
      );
    }
    if (page.total !== firstPage.total) {
      throw new ResponseShapeError(`Investment page ${requestedPage} for connection ${connectionId} changed total`);
    }
    if (page.totalPages !== firstPage.totalPages) {
      throw new ResponseShapeError(`Investment page ${requestedPage} for connection ${connectionId} changed totalPages`);
    }
  }
}

function mapInvestments(
  pages: readonly InvestmentPage[],
  connection: Connection,
  connectionId: string,
): readonly InvestmentPosition[] {
  const seenIds = new Set<string>();
  const investments: InvestmentPosition[] = [];
  for (const page of pages) {
    for (const row of page.results) {
      if (seenIds.has(row.id)) {
        throw new ResponseShapeError(`Investment ${row.id} was already seen for connection ${connectionId}`);
      }
      seenIds.add(row.id);

      const investment = toInvestment(row, connection);
      if (investment !== null) {
        investments.push(investment);
      }
    }
  }
  return investments;
}


function newestBillFirst(left: Bill, right: Bill): number {
  if (left.closingDate === null) {
    if (right.closingDate !== null) {
      return 1;
    }
  } else if (right.closingDate === null) {
    return -1;
  } else {
    const closingDateOrder = right.closingDate.localeCompare(left.closingDate);
    if (closingDateOrder !== 0) {
      return closingDateOrder;
    }
  }

  return right.dueDate.localeCompare(left.dueDate);
}

/**
 * The Pluggy client, written rather than taken from `pluggy-sdk`.
 *
 * The SDK resolves the key lazily and checks the JWT already, so the ADR's
 * original complaint does not apply to it. What it has no way to offer is a
 * margin, a single-flight, a 401 retry or a rate limiter, because the key cache
 * is private instance state and the send function is not ours. ADR §15 Phase 0
 * records the whole comparison. All four live in `transport.ts`; what is left
 * here is the vocabulary of connections.
 *
 * Construction performs no I/O (§16.2).
 */
// eslint-disable-next-line max-lines-per-function -- a factory that assembles and returns one object, not logic to cut apart
export function createPluggyClient(options: PluggyClientOptions): Bank {
  const transport = createTransport(options);

  async function get<T>(path: string, schema: z.ZodType<T>, describe: string): Promise<T> {
    const response = await transport.authorized("GET", path);

    if (!response.ok) {
      throw await failureFor(response, describe);
    }

    return parse(schema, await readJson(response), describe);
  }

  const walkTransactions = createTransactionWalker(get);
  const walkInvestments = createInvestmentWalker(get);

  return {
    verifyCredentials: async () => {
      await transport.key();
    },

    getConnection: async (id: string): Promise<Connection> => {
      const item = await get(`/items/${encodeURIComponent(id)}`, ITEM, `connection ${id}`);
      return toConnection(item);
    },

    getAccounts: async (connectionId: string): Promise<readonly Account[]> => {
      const encodedConnectionId = encodeURIComponent(connectionId);
      const [item, firstPage] = await Promise.all([
        get(`/items/${encodedConnectionId}`, ITEM, `connection ${connectionId}`),
        get(`/accounts?itemId=${encodedConnectionId}&pageSize=500&page=1`, ACCOUNT_PAGE, `accounts ${connectionId}`),
      ]);
      const connection = toConnection(item);
      const pages = await Promise.all(
        Array.from({ length: firstPage.totalPages - 1 }, (_, index) =>
          get(
            `/accounts?itemId=${encodedConnectionId}&pageSize=500&page=${index + 2}`,
            ACCOUNT_PAGE,
            `accounts ${connectionId}`,
          ),
        ),
      );

      return [firstPage, ...pages].flatMap((page) => page.results.map((account) => toAccount(account, connection)));
    },

    getInvestments: walkInvestments,

    getAccount: async (accountId: string): Promise<Account> => {
      const account = await get(`/accounts/${encodeURIComponent(accountId)}`, ACCOUNT, `account ${accountId}`);
      const item = await get(`/items/${encodeURIComponent(account.itemId)}`, ITEM, `connection ${account.itemId}`);
      return toAccount(account, toConnection(item));
    },

    getTransactions: (account) => walkTransactions(account),

    getBills: async (account: Account): Promise<readonly Bill[]> => {
      const encodedAccountId = encodeURIComponent(account.id);
      const firstPage = await get(
        `/bills?accountId=${encodedAccountId}&pageSize=500&page=1`,
        BILL_PAGE,
        `bills ${account.id}`,
      );
      const pages = await Promise.all(
        Array.from({ length: firstPage.totalPages - 1 }, (_, index) =>
          get(
            `/bills?accountId=${encodedAccountId}&pageSize=500&page=${index + 2}`,
            BILL_PAGE,
            `bills ${account.id}`,
          ),
        ),
      );
      const seenIds = new Set<string>();
      const bills: Bill[] = [];

      for (const page of [firstPage, ...pages]) {
        for (const row of page.results) {
          if (seenIds.has(row.id)) {
            throw new ResponseShapeError(`Bill ${row.id} was already seen while walking ${account.id}`);
          }
          seenIds.add(row.id);
          bills.push(toBill(row, account));
        }
      }

      return bills.sort(newestBillFirst);
    },

    getConsent: async (connectionId: string): Promise<Consent | null> => {
      const encodedConnectionId = encodeURIComponent(connectionId);
      const page = await get(
        `/consents?itemId=${encodedConnectionId}`,
        CONSENT_PAGE,
        `consent ${connectionId}`,
      );
      const [first] = page.results;
      if (first === undefined) {
        return null;
      }
      return toConsent(first);
    },
  };
}

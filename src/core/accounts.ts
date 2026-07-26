import type { Account } from "./account.ts";
import type { Bank, BankFailure } from "./contracts.ts";

/** A configured connection that did not provide accounts for the current call. */
export type UnavailableConnection = BankFailure & {
  readonly connectionId: string;
};

/** Accounts collected across connections, including every unavailable connection. */
export type CollectedAccounts = {
  readonly accounts: readonly Account[];
  readonly unavailable: readonly UnavailableConnection[];
};

/**
 * Collects accounts from every configured connection concurrently.
 *
 * A rejected request and a successful empty response both leave the connection
 * unavailable so callers never mistake partial coverage for complete data.
 */
export async function collectAccounts(
  bank: Bank,
  connectionIds: readonly string[],
  toFailure: (error: unknown) => BankFailure,
): Promise<CollectedAccounts> {
  const requests = connectionIds.map((connectionId) => ({
    connectionId,
    accounts: bank.getAccounts(connectionId),
  }));
  const settled = await Promise.allSettled(requests.map(({ accounts }) => accounts));
  const accounts: Account[] = [];
  const unavailable: UnavailableConnection[] = [];

  for (const [index, result] of settled.entries()) {
    const { connectionId } = requests[index]!;

    if (result.status === "rejected") {
      unavailable.push({ connectionId, ...toFailure(result.reason) });
      continue;
    }

    if (result.value.length === 0) {
      unavailable.push({
        connectionId,
        kind: "no-accounts",
        message: `Connection ${connectionId} answered but returned no accounts; revoked consent is the usual cause.`,
      });
      continue;
    }

    accounts.push(...result.value);
  }

  return { accounts, unavailable };
}

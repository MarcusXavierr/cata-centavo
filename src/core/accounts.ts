import type { Account } from "./account.ts";
import { consentState, type ConsentState } from "./consent.ts";
import type { Bank, BankFailure, Clock, Consent } from "./contracts.ts";

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
  clock: Clock,
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
      unavailable.push(await diagnoseEmpty(bank, connectionId, clock));
      continue;
    }

    accounts.push(...result.value);
  }

  return { accounts, unavailable };
}

function noAccountsFailure(connectionId: string): UnavailableConnection {
  return {
    connectionId,
    kind: "no-accounts",
    message: `Connection ${connectionId} answered but returned no accounts.`,
  };
}

function dateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Why an empty account list came back. A diagnostic query that itself fails
 * must not turn a mild "no accounts" into a crash — it exists to explain, not
 * to bring the call down — so any error from `getConsent` falls back to the
 * same `no-accounts` result a connection with no observable consent gets.
 */
async function diagnoseEmpty(bank: Bank, connectionId: string, clock: Clock): Promise<UnavailableConnection> {
  let consent: Consent | null;
  try {
    consent = await bank.getConsent(connectionId);
  } catch {
    return noAccountsFailure(connectionId);
  }

  return consentFailure(connectionId, consent, consentState(consent, clock.now()));
}

function consentFailure(connectionId: string, consent: Consent | null, state: ConsentState): UnavailableConnection {
  if (state === "revoked") {
    return revokedFailure(connectionId, dateField(consent, "revokedAt"));
  }

  if (state === "expired") {
    return expiredFailure(connectionId, dateField(consent, "expiresAt"));
  }

  return noAccountsFailure(connectionId);
}

function dateField(consent: Consent | null, field: "revokedAt" | "expiresAt"): Date | null {
  if (consent === null) {
    return null;
  }
  return consent[field];
}

function revokedFailure(connectionId: string, revokedAt: Date | null): UnavailableConnection {
  if (revokedAt === null) {
    return noAccountsFailure(connectionId);
  }
  return {
    connectionId,
    kind: "consent-revoked",
    message: `Connection ${connectionId}'s consent was revoked on ${dateOnly(revokedAt)}; re-link this connection to restore access.`,
  };
}

function expiredFailure(connectionId: string, expiresAt: Date | null): UnavailableConnection {
  if (expiresAt === null) {
    return noAccountsFailure(connectionId);
  }
  return {
    connectionId,
    kind: "consent-expired",
    message: `Connection ${connectionId}'s consent expired on ${dateOnly(expiresAt)}.`,
  };
}

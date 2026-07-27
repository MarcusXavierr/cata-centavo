import { consentState, type ConsentState } from "./consent.ts";
import type { Bank, BankFailure, Clock, Connection, Consent } from "./contracts.ts";

export type ConnectionDiagnosis = {
  readonly id: string;
  readonly connection: Connection | null;
  readonly failure: BankFailure | null;
  readonly consent: Consent | null;
  readonly state: ConsentState;
};

/**
 * The connection status and the consent behind it, for every configured id.
 *
 * The two requests per connection fire together and settle independently: a
 * consent lookup that fails must not take the item status with it, and the
 * reverse holds too. One bad id does not abort the rest, and output order
 * follows `connectionIds` so the report lines up with what the user
 * configured.
 */
export async function diagnose(
  bank: Bank,
  connectionIds: readonly string[],
  toFailure: (error: unknown) => BankFailure,
  clock: Clock,
): Promise<readonly ConnectionDiagnosis[]> {
  return Promise.all(connectionIds.map((id) => diagnoseOne(bank, id, toFailure, clock)));
}

async function diagnoseOne(
  bank: Bank,
  id: string,
  toFailure: (error: unknown) => BankFailure,
  clock: Clock,
): Promise<ConnectionDiagnosis> {
  const [connectionResult, consentResult] = await Promise.allSettled([bank.getConnection(id), bank.getConsent(id)]);

  const { connection, failure } = readConnection(connectionResult, toFailure);
  const consent = readConsent(consentResult);

  return { id, connection, failure, consent, state: consentState(consent, clock.now()) };
}

function readConnection(
  result: PromiseSettledResult<Connection>,
  toFailure: (error: unknown) => BankFailure,
): { readonly connection: Connection | null; readonly failure: BankFailure | null } {
  if (result.status === "fulfilled") {
    return { connection: result.value, failure: null };
  }
  return { connection: null, failure: toFailure(result.reason) };
}

function readConsent(result: PromiseSettledResult<Consent | null>): Consent | null {
  if (result.status === "fulfilled") {
    return result.value;
  }
  return null;
}

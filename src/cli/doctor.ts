import { loadConfig, type Credentials, type Env } from "../config.ts";
import type { ConsentState } from "../core/consent.ts";
import type { Bank, BankFailure, Clock, Connection, Consent } from "../core/contracts.ts";
import { diagnose, type ConnectionDiagnosis } from "../core/diagnose.ts";
import { describeSync, relativeAgo } from "./sync.ts";

/**
 * `doctor` reads what `init` reads, plus the consent behind each connection
 * and what is on disk. The contract belongs to this consumer (ADR §6): the
 * shape below mirrors `storage/diagnostics.ts`'s `LocalState` structurally,
 * but does not import it — only `bin/` may reach into `storage/`.
 */
export type LocalState = {
  readonly cacheDb: string;
  readonly dataDb: string;
  readonly cacheVersion: number;
  readonly dataVersion: number;
  readonly accountsWalked: number;
  readonly newestLocalDate: string | null;
  readonly perConnection: ReadonlyMap<string, { readonly accounts: number; readonly oldestWalk: string | null }>;
  readonly snapshotRows: number;
  readonly counterpartyDocuments: number;
  readonly mccRows: number;
};

export type DoctorDeps = {
  readonly env: Env;
  readonly createBank: (credentials: Credentials) => Bank;
  /** Opens both files, reads their state, and closes them again. */
  readonly readLocalState: () => LocalState;
  readonly toFailure: (error: unknown) => BankFailure;
  readonly clock: Clock;
};

export type DoctorReport =
  | { readonly kind: "config"; readonly problems: readonly string[] }
  | { readonly kind: "storage"; readonly reason: string }
  | { readonly kind: "credentials"; readonly localState: LocalState; readonly reason: string }
  | { readonly kind: "checked"; readonly localState: LocalState; readonly diagnoses: readonly ConnectionDiagnosis[] };

export async function runDoctor(deps: DoctorDeps): Promise<DoctorReport> {
  const config = loadConfig(deps.env);
  if (!config.ok) {
    return { kind: "config", problems: config.problems };
  }

  let localState: LocalState;
  try {
    localState = deps.readLocalState();
  } catch (error) {
    return { kind: "storage", reason: describe(error) };
  }

  const bank = deps.createBank(config.config.credentials);

  try {
    await bank.verifyCredentials();
  } catch (error) {
    return { kind: "credentials", localState, reason: describe(error) };
  }

  const diagnoses = await diagnose(bank, config.config.itemIds, deps.toFailure, deps.clock);

  return { kind: "checked", localState, diagnoses };
}

function isUsable(diagnosis: ConnectionDiagnosis): boolean {
  return diagnosis.connection !== null && diagnosis.state !== "revoked" && diagnosis.state !== "expired";
}

export function exitCodeFor(report: DoctorReport): number {
  switch (report.kind) {
    case "config":
      return 2;
    case "storage":
    case "credentials":
      return 1;
    case "checked":
      if (report.diagnoses.every(isUsable)) {
        return 0;
      }
      return 1;
  }
}

/** Lines for stderr. Nothing here may reach stdout (ADR §4). */
export function formatDoctor(report: DoctorReport, clock: Clock): readonly string[] {
  switch (report.kind) {
    case "config":
      return ["✗ configuration is incomplete", ...report.problems.map((problem) => `  ${problem}`)];

    case "storage":
      return [`✗ local storage is unreadable: ${report.reason}`];

    case "credentials":
      return [
        ...formatStorage(report.localState),
        "",
        ...formatCache(report.localState, clock),
        "",
        ...formatCategorization(report.localState),
        "",
        `✗ ${report.reason}`,
      ];

    case "checked":
      return formatChecked(report, clock);
  }
}

function formatChecked(
  report: Extract<DoctorReport, { readonly kind: "checked" }>,
  clock: Clock,
): readonly string[] {
  const usable = report.diagnoses.filter(isUsable).length;

  return [
    "connections",
    ...report.diagnoses.flatMap((diagnosis) => formatConnection(diagnosis, clock)),
    "",
    ...formatStorage(report.localState),
    "",
    ...formatCache(report.localState, clock),
    "",
    ...formatCategorization(report.localState),
    "",
    `${usable} of ${report.diagnoses.length} connections are usable`,
  ];
}

function formatConnection(diagnosis: ConnectionDiagnosis, clock: Clock): readonly string[] {
  if (diagnosis.connection === null) {
    return [`  ✗ ${diagnosis.id} — ${diagnosis.failure?.message ?? "unknown failure"}`];
  }

  if (diagnosis.state === "revoked") {
    return [`  ✗ ${diagnosis.id} — ${revokedReason(diagnosis.consent, diagnosis.id)}`];
  }

  if (diagnosis.state === "expired") {
    return [`  ✗ ${diagnosis.id} — ${expiredReason(diagnosis.consent, diagnosis.id)}`];
  }

  return formatUsableConnection(diagnosis, diagnosis.connection, clock);
}

function revokedReason(consent: Consent | null, id: string): string {
  if (consent?.revokedAt === undefined || consent.revokedAt === null) {
    return `${id} has an unreadable consent`;
  }
  return `consent revoked on ${dateOnly(consent.revokedAt)}; re-link this connection to restore access.`;
}

function expiredReason(consent: Consent | null, id: string): string {
  if (consent?.expiresAt === undefined || consent.expiresAt === null) {
    return `${id} has an unreadable consent`;
  }
  return `consent expired on ${dateOnly(consent.expiresAt)}.`;
}

function connectionMarker(connection: Connection): string {
  if (connection.warnings.length > 0) {
    return "!";
  }
  return "✓";
}

function formatUsableConnection(diagnosis: ConnectionDiagnosis, connection: Connection, clock: Clock): readonly string[] {
  const { id, state, consent } = diagnosis;
  const sync = describeSync(connection.lastUpdatedAt, clock.now());

  return [
    `  ${connectionMarker(connection)} ${id}  ${connection.institution}  ${connection.status}  ${sync}`,
    `           ${consentLine(state, consent)}`,
    ...connection.warnings.map((warning) => `    ${warning}`),
  ];
}

function consentLine(state: ConsentState, consent: Consent | null): string {
  if (consent === null) {
    return `consent: ${state}`;
  }
  return `consent: ${state}, ${consent.products.length} products`;
}

function dateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function formatStorage(state: LocalState): readonly string[] {
  return [
    "storage",
    `  ✓ cache  v${state.cacheVersion}  ${state.cacheDb}`,
    `  ✓ data   v${state.dataVersion}  ${state.dataDb}`,
  ];
}

function formatCache(state: LocalState, clock: Clock): readonly string[] {
  return [
    "cache",
    `  ${cacheSummaryLine(state)}`,
    ...[...state.perConnection.entries()].map(([connectionId, entry]) => formatCacheConnection(connectionId, entry, clock)),
  ];
}

function cacheSummaryLine(state: LocalState): string {
  if (state.newestLocalDate === null) {
    return "no transactions cached yet";
  }
  return `${state.accountsWalked} accounts walked, newest transaction ${state.newestLocalDate}`;
}

function formatCacheConnection(
  connectionId: string,
  entry: { readonly accounts: number; readonly oldestWalk: string | null },
  clock: Clock,
): string {
  const oldestWalkDate = oldestWalkDateOf(entry.oldestWalk);
  return `  ${connectionId}  ${entry.accounts} accounts, oldest walk ${relativeAgo(oldestWalkDate, clock.now())}`;
}

function oldestWalkDateOf(oldestWalk: string | null): Date | null {
  if (oldestWalk === null) {
    return null;
  }
  return new Date(oldestWalk);
}

function merchantCodesLine(mccRows: number): string {
  if (mccRows > 0) {
    return "merchant codes present";
  }
  return "merchant codes missing";
}

function formatCategorization(state: LocalState): readonly string[] {
  const merchantLine = merchantCodesLine(state.mccRows);

  return [
    "categorization",
    `  snapshot      ${state.snapshotRows} transactions`,
    `  counterparty  ${state.counterpartyDocuments} documents`,
    `  ${merchantLine}`,
  ];
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

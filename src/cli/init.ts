import { loadConfig, type Credentials, type Env } from "../config.ts";
import type { Bank, Clock, Connection } from "../core/contracts.ts";

/**
 * `init` validates and reports. It writes nothing locally, because configuration
 * lives in the environment (ADR §4 and §14.6, amended 2026-07-25).
 *
 * Every configured id is read from the API now, so a mis-pasted UUID costs two
 * seconds instead of two weeks of empty statements. Reading is all it does:
 * connector 200 refuses `PATCH /items/{id}` unconditionally, so there is no
 * on-demand sync to ask for. `docs/research/pluggy-item-update.md` has the
 * evidence.
 */

export type ConnectionOutcome =
  | { readonly kind: "usable"; readonly id: string; readonly connection: Connection }
  | { readonly kind: "failed"; readonly id: string; readonly reason: string };

/** Where the two files of ADR §10 landed, and what version they carry. */
export type StorageInfo = {
  readonly cacheDb: string;
  readonly dataDb: string;
  readonly cacheVersion: number;
  readonly dataVersion: number;
};

export type InitReport =
  | { readonly kind: "config"; readonly problems: readonly string[] }
  | { readonly kind: "storage"; readonly reason: string }
  | { readonly kind: "credentials"; readonly storage: StorageInfo; readonly reason: string }
  | { readonly kind: "checked"; readonly storage: StorageInfo; readonly outcomes: readonly ConnectionOutcome[] };

export type InitDeps = {
  readonly env: Env;
  readonly createBank: (credentials: Credentials) => Bank;
  /** Opens both files, runs their migrations and closes them again. */
  readonly prepareStorage: () => StorageInfo;
};

export async function runInit(deps: InitDeps): Promise<InitReport> {
  const config = loadConfig(deps.env);
  if (!config.ok) {
    return { kind: "config", problems: config.problems };
  }

  // Before the network, because a data.db this release cannot read is worth
  // saying out loud rather than after a round of API calls.
  let storage: StorageInfo;
  try {
    storage = deps.prepareStorage();
  } catch (error) {
    return { kind: "storage", reason: describe(error) };
  }

  const bank = deps.createBank(config.config.credentials);

  try {
    await bank.verifyCredentials();
  } catch (error) {
    return { kind: "credentials", storage, reason: describe(error) };
  }

  const outcomes = await Promise.all(config.config.itemIds.map((id) => check(bank, id)));

  return { kind: "checked", storage, outcomes };
}

/**
 * One bad id does not abort the rest. A report covering every connection is worth
 * more than one that stops at the first bad line, and the exit code carries the
 * failure instead.
 */
async function check(bank: Bank, id: string): Promise<ConnectionOutcome> {
  try {
    return { kind: "usable", id, connection: await bank.getConnection(id) };
  } catch (error) {
    return { kind: "failed", id, reason: describe(error) };
  }
}

export function exitCodeFor(report: InitReport): number {
  switch (report.kind) {
    case "config":
      return 2;
    case "storage":
    case "credentials":
      return 1;
    case "checked":
      return report.outcomes.every((outcome) => outcome.kind === "usable") ? 0 : 1;
  }
}

/** Lines for stderr. Nothing here may reach stdout (ADR §4). */
export function formatInit(report: InitReport, clock: Clock): readonly string[] {
  const configRead = "✓ configuration read from the environment";

  switch (report.kind) {
    case "config":
      return ["✗ configuration is incomplete", ...report.problems.map((problem) => `  ${problem}`)];

    case "storage":
      return [configRead, `✗ local storage is unusable: ${report.reason}`];

    case "credentials":
      return [configRead, ...formatStorage(report.storage), `✗ ${report.reason}`];

    case "checked": {
      const usable = report.outcomes.filter((outcome) => outcome.kind === "usable").length;

      return [
        configRead,
        ...formatStorage(report.storage),
        "✓ credentials accepted",
        ...report.outcomes.flatMap((outcome) => formatOutcome(outcome, clock)),
        "",
        `${usable} of ${report.outcomes.length} connections are usable`,
      ];
    }
  }
}

function formatStorage(storage: StorageInfo): readonly string[] {
  return [
    `✓ cache   v${storage.cacheVersion}  ${storage.cacheDb}`,
    `✓ data    v${storage.dataVersion}  ${storage.dataDb}`,
  ];
}

function formatOutcome(outcome: ConnectionOutcome, clock: Clock): readonly string[] {
  return outcome.kind === "failed"
    ? [`✗ ${outcome.id} — ${outcome.reason}`]
    : formatUsable(outcome, clock);
}

/**
 * A `!` rather than a `✓`, because a product that hit its Open Finance monthly
 * quota went unsynced and the numbers below it are older than the rest. Worth
 * saying out loud, and not worth failing over.
 */
function formatUsable(
  outcome: Extract<ConnectionOutcome, { readonly kind: "usable" }>,
  clock: Clock,
): readonly string[] {
  const { institution, status, lastUpdatedAt, parameter, warnings } = outcome.connection;
  const state = `${institution}, ${status}, ${describeSync(lastUpdatedAt, clock.now())}`;

  return [
    `${warnings.length > 0 ? "!" : "✓"} ${outcome.id} — ${state}${waitingOn(parameter)}`,
    ...warnings.map((warning) => `    ${warning}`),
  ];
}

/**
 * A read-only fact rather than a verdict: the connection is as usable as any
 * other, and the bank happens to have named what it is waiting on.
 */
function waitingOn(parameter: string | null): string {
  return parameter === null ? "" : ` — the bank is waiting on you: ${parameter}`;
}

function describeSync(lastUpdatedAt: Date | null, now: Date): string {
  if (lastUpdatedAt === null) {
    return "never synced";
  }

  const minutes = Math.floor((now.getTime() - lastUpdatedAt.getTime()) / 60_000);
  if (minutes < 1) {
    return "synced just now";
  }
  if (minutes < 60) {
    return `synced ${minutes}m ago`;
  }

  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `synced ${hours}h ago` : `synced ${Math.floor(hours / 24)}d ago`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

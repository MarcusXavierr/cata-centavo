import { loadConfig, type Credentials, type Env } from "../config.ts";
import type { Bank, Clock, Connection, Sleep } from "../core/contracts.ts";
import { refresh, type RefreshEvent } from "../core/refresh.ts";
import type { Row } from "./progress.ts";

/**
 * `init` validates, refreshes and reports. It writes nothing locally, because
 * configuration lives in the environment (ADR §4 and §14.6, amended 2026-07-25).
 *
 * What survives from the original design is the part that mattered: every id is
 * checked against the API now, so a mis-pasted UUID costs two seconds instead of
 * two weeks of empty statements. What is new is that a stale connection is no
 * longer only reported — every configured connection is asked to sync
 * (`PATCH /items/{id}`) and waited on.
 *
 * That ask is unconditional and deliberately so. Pluggy enforces a minimum
 * interval between updates per client and refuses with a 409 naming it, which is
 * the "debounce measured in hours" of ADR §11 — server-side, and needing no local
 * state. So the refusal is a success here, not a failure: see the `already-fresh`
 * outcome. `docs/research/pluggy-item-update.md` has the sources.
 */

export type ConnectionOutcome =
  | { readonly kind: "refreshed"; readonly id: string; readonly connection: Connection }
  | {
      readonly kind: "already-fresh";
      readonly id: string;
      readonly connection: Connection;
      readonly everyHours: number | null;
    }
  | { readonly kind: "not-refreshable"; readonly id: string; readonly connection: Connection }
  | { readonly kind: "needs-user"; readonly id: string; readonly connection: Connection }
  | { readonly kind: "login-error"; readonly id: string; readonly connection: Connection }
  | { readonly kind: "still-updating"; readonly id: string; readonly connection: Connection }
  | {
      readonly kind: "failed";
      readonly id: string;
      /** Null when the failure was the read that would have told us the name. */
      readonly institution: string | null;
      readonly reason: string;
    };

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
  /** How the poll loop waits. Injected so a test never does. */
  readonly sleep: Sleep;
  /** The connections still in flight, whenever that set changes. */
  readonly report: (rows: readonly Row[]) => void;
};

export async function runInit(deps: InitDeps): Promise<InitReport> {
  const config = loadConfig(deps.env);
  if (!config.ok) {
    return { kind: "config", problems: config.problems };
  }

  // Before the network, because a data.db this release cannot read is worth
  // saying out loud rather than after a minute of API calls.
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

  const live = liveRows(deps.report);
  const outcomes = await Promise.all(config.config.itemIds.map((id) => check(deps, bank, id, live)));

  return { kind: "checked", storage, outcomes };
}

type Live = { record(id: string, label: string): void; observe(event: RefreshEvent): void };

/**
 * Turns the per-connection stage events into the set of rows on screen. A
 * connection is on it from its first stage until it settles, and nothing else is,
 * so the display empties itself as the run finishes.
 */
function liveRows(report: (rows: readonly Row[]) => void): Live {
  const labels = new Map<string, string>();
  const rows = new Map<string, Row>();

  return {
    record: (id, label) => {
      labels.set(id, label);
    },

    observe: (event) => {
      if (event.kind === "settled") {
        rows.delete(event.id);
      } else {
        rows.set(event.id, { label: labels.get(event.id) ?? event.id, detail: event.label });
      }

      report([...rows.values()]);
    },
  };
}

/**
 * One bad id does not abort the rest. A report covering every connection is worth
 * more than one that stops at the first bad line, and the exit code carries the
 * failure instead.
 *
 * The read comes before the refresh for two reasons: a 404 catches a mis-pasted
 * UUID before anything is spent, and it is what lets the spinner say "Nubank"
 * rather than a UUID for the next several minutes.
 */
async function check(deps: InitDeps, bank: Bank, id: string, live: Live): Promise<ConnectionOutcome> {
  let known: Connection;
  try {
    known = await bank.getConnection(id);
  } catch (error) {
    return { kind: "failed", id, institution: null, reason: describe(error) };
  }

  live.record(id, known.institution);

  const outcome = await refresh({ bank, sleep: deps.sleep, report: live.observe }, id);

  switch (outcome.kind) {
    case "already-fresh":
      return { kind: "already-fresh", id, connection: known, everyHours: outcome.everyHours };
    // Both refusals report the connection we already read, since a refused
    // refresh left it exactly as it was.
    case "not-refreshable":
      return { kind: "not-refreshable", id, connection: known };
    case "failed":
      return { kind: "failed", id, institution: known.institution, reason: outcome.reason };
    default:
      return { kind: outcome.kind, id, connection: outcome.connection };
  }
}

/**
 * A connection is usable when its data is readable, which is a weaker claim than
 * having just been refreshed. `not-refreshable` belongs here for the same reason
 * `already-fresh` does: no sync happened, and none was needed for the tools to
 * work.
 */
const USABLE = new Set(["refreshed", "already-fresh", "not-refreshable"]);

export function exitCodeFor(report: InitReport): number {
  switch (report.kind) {
    case "config":
      return 2;
    case "storage":
    case "credentials":
      return 1;
    case "checked":
      return report.outcomes.every((outcome) => USABLE.has(outcome.kind)) ? 0 : 1;
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
      const usable = report.outcomes.filter((outcome) => USABLE.has(outcome.kind)).length;

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

/** The outcomes that carry the connection they are talking about. */
type SettledOutcome = Exclude<ConnectionOutcome, { readonly kind: "failed" }>;

function formatOutcome(outcome: ConnectionOutcome, clock: Clock): readonly string[] {
  return outcome.kind === "failed" ? formatFailure(outcome) : formatSettled(outcome, clock);
}

function formatFailure(outcome: Extract<ConnectionOutcome, { readonly kind: "failed" }>): readonly string[] {
  const who = outcome.institution === null ? "" : `${outcome.institution}: `;

  return [`✗ ${outcome.id} — ${who}${outcome.reason}`];
}

/**
 * Splitting this union in two would put the shape of the report in two places.
 * The count is one branch per outcome kind and nothing else, and the compiler is
 * what keeps that set complete — hence the suppression rather than a refactor.
 */
// eslint-disable-next-line complexity -- one branch per outcome kind; see above
function formatSettled(outcome: SettledOutcome, clock: Clock): readonly string[] {
  const { institution, status, lastUpdatedAt, parameter, warnings } = outcome.connection;
  const state = `${institution}, ${status}, ${describeSync(lastUpdatedAt, clock.now())}`;

  switch (outcome.kind) {
    case "refreshed":
      return formatRefreshed(outcome.id, state, warnings);

    case "already-fresh":
      return [`· ${outcome.id} — ${state} — already fresh, ${describeInterval(outcome.everyHours)}`];

    // A `✓` because the connection is as usable as any other: the only thing
    // missing is the one thing we asked for and cannot have.
    case "not-refreshable":
      return [
        `✓ ${outcome.id} — ${state}`,
        "    this connector cannot be refreshed on demand; Pluggy syncs it on its own schedule",
      ];

    case "needs-user":
      return formatNeedsUser(outcome.id, institution, parameter);

    case "login-error":
      return [
        `✗ ${outcome.id} — ${institution} refused the login`,
        "    the credentials have to be re-entered in Pluggy Connect; the API cannot do it",
      ];

    case "still-updating":
      return [`⋯ ${outcome.id} — ${institution} is still syncing — it carries on at Pluggy, so run init again shortly`];
  }
}

/**
 * A `!` rather than a `✓`, because a product that hit its Open Finance monthly
 * quota went unrefreshed and the numbers below it are older than the rest.
 * Worth saying out loud, and not worth failing over.
 */
function formatRefreshed(id: string, state: string, warnings: readonly string[]): readonly string[] {
  return [
    `${warnings.length > 0 ? "!" : "✓"} ${id} — ${state}`,
    ...warnings.map((warning) => `    ${warning}`),
  ];
}

function formatNeedsUser(id: string, institution: string, parameter: string | null): readonly string[] {
  return [
    `✗ ${id} — ${institution} is waiting on you${parameter === null ? "" : `: ${parameter}`}`,
    "    run init again with it to hand, the bank asks once per attempt",
  ];
}

function describeInterval(everyHours: number | null): string {
  return everyHours === null
    ? "Pluggy declined to sync again this soon"
    : `Pluggy allows one update every ${everyHours}h`;
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

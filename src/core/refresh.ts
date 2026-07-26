import type { Bank, Connection, Sleep } from "./contracts.ts";

/**
 * Asking an institution for fresh data, and waiting for it.
 *
 * Pluggy's `PATCH /items/{id}` only *starts* a sync; the result arrives by
 * polling `GET /items/{id}` until the status stops saying `UPDATING`. This is the
 * poll-and-wait shape of ADR §16.1, with the one correction §16.1 asks for:
 * `PARTIAL_SUCCESS` is a refresh, not a failure.
 *
 * The loop condition is `status === "UPDATING"` and nothing else, copied from
 * Pluggy's own polling recipe. Everything else is terminal, so a status neither
 * we nor the docs have seen ends the loop and gets reported, rather than spinning
 * for nineteen minutes. `docs/research/pluggy-item-update.md` has the sources.
 */

export type RefreshEvent =
  | { readonly kind: "stage"; readonly id: string; readonly label: string }
  | { readonly kind: "settled"; readonly id: string };

export type RefreshDeps = {
  readonly bank: Bank;
  readonly sleep: Sleep;
  readonly report: (event: RefreshEvent) => void;
};

export type RefreshOutcome =
  | { readonly kind: "refreshed"; readonly connection: Connection }
  | {
      readonly kind: "already-fresh";
      readonly everyHours: number | null;
      readonly lastUpdatedAt: Date | null;
    }
  /** The connector offers no on-demand update. Nothing was tried, nothing broke. */
  | { readonly kind: "not-refreshable" }
  | { readonly kind: "needs-user"; readonly connection: Connection }
  | { readonly kind: "login-error"; readonly connection: Connection }
  | { readonly kind: "still-updating"; readonly connection: Connection }
  | { readonly kind: "failed"; readonly reason: string };

/**
 * 2s doubling to a 30s ceiling over 40 attempts is a little over eighteen
 * minutes of patience, chosen against the documented five-minute worst case for
 * the login step alone.
 */
export const POLL = { firstDelayMs: 2_000, maxDelayMs: 30_000, attempts: 40 } as const;

export const PHASES = {
  updating: "updating",
  refreshed: "refreshed",
  needsUser: "needs-user",
  loginError: "login-error",
  failed: "failed",
} as const;

export type RefreshPhase = (typeof PHASES)[keyof typeof PHASES];

export async function refresh(deps: RefreshDeps, id: string): Promise<RefreshOutcome> {
  try {
    const start = await deps.bank.refreshConnection(id);

    if (start.kind === "too-soon") {
      return { kind: "already-fresh", everyHours: start.everyHours, lastUpdatedAt: start.lastUpdatedAt };
    }

    if (start.kind === "not-refreshable") {
      return { kind: "not-refreshable" };
    }

    return await poll(deps, id, start.connection);
  } catch (error) {
    return { kind: "failed", reason: error instanceof Error ? error.message : String(error) };
  } finally {
    deps.report({ kind: "settled", id });
  }
}

async function poll(deps: RefreshDeps, id: string, first: Connection): Promise<RefreshOutcome> {
  let connection = first;
  let stage: string | null = null;

  /** Silent while the stage repeats, so a long sync reports a handful of times. */
  const announce = (current: Connection): void => {
    if (phaseOf(current) !== PHASES.updating) {
      return;
    }

    const label = stageLabel(current.executionStatus);
    if (label !== stage) {
      stage = label;
      deps.report({ kind: "stage", id, label });
    }
  };

  announce(connection);
  let delay: number = POLL.firstDelayMs;

  for (let attempt = 0; attempt < POLL.attempts; attempt += 1) {
    const phase = phaseOf(connection);
    if (phase !== PHASES.updating) {
      return settled(phase, connection);
    }

    await deps.sleep(delay);
    delay = Math.min(delay * 2, POLL.maxDelayMs);

    connection = await deps.bank.getConnection(id);
    announce(connection);
  }

  const phase = phaseOf(connection);

  // Running out of patience is not a failure. The sync continues at Pluggy, and
  // the next `init` will find it finished.
  return phase === PHASES.updating ? { kind: "still-updating", connection } : settled(phase, connection);
}

function settled(phase: RefreshPhase, connection: Connection): RefreshOutcome {
  switch (phase) {
    case PHASES.refreshed:
      return { kind: "refreshed", connection };
    case PHASES.needsUser:
      return { kind: "needs-user", connection };
    case PHASES.loginError:
      return { kind: "login-error", connection };
    default:
      return {
        kind: "failed",
        reason: `Pluggy ended the sync as ${connection.status} / ${connection.executionStatus ?? "no execution status"}`,
      };
  }
}

const SUCCEEDED = new Set(["SUCCESS", "PARTIAL_SUCCESS"]);

/**
 * Every status whose phase `status` alone decides. `UPDATED` is the one that
 * needs a second look and so is missing here.
 */
const PHASE_BY_STATUS: Readonly<Record<string, RefreshPhase>> = {
  UPDATING: PHASES.updating,
  MERGING: PHASES.updating,
  // Undocumented as a `status`, yet Pluggy's own rate-limit page shows an item
  // carrying it. Treated as the success it describes.
  PARTIAL_SUCCESS: PHASES.refreshed,
  WAITING_USER_INPUT: PHASES.needsUser,
  WAITING_USER_ACTION: PHASES.needsUser,
  LOGIN_ERROR: PHASES.loginError,
};

export function phaseOf(connection: Connection): RefreshPhase {
  if (connection.status === "UPDATED") {
    return updatedPhase(connection.executionStatus);
  }

  return PHASE_BY_STATUS[connection.status] ?? PHASES.failed;
}

/**
 * `status` is authoritative here: a missing `executionStatus` on an item Pluggy
 * calls UPDATED is not a reason to call the sync broken.
 */
function updatedPhase(executionStatus: string | null): RefreshPhase {
  return executionStatus === null || SUCCEEDED.has(executionStatus) ? PHASES.refreshed : PHASES.failed;
}

const STAGES: Readonly<Record<string, string>> = {
  CREATED: "starting",
  CREATING: "starting",
  LOGIN_IN_PROGRESS: "logging in",
  LOGIN_MFA_IN_PROGRESS: "sending the second factor",
  WAITING_USER_INPUT: "waiting for your token",
  WAITING_USER_ACTION: "waiting for you at the bank",
  USER_AUTHORIZATION_PENDING: "waiting for the bank to authorize us",
  ACCOUNTS_IN_PROGRESS: "reading accounts",
  CREDITCARDS_IN_PROGRESS: "reading credit cards",
  TRANSACTIONS_IN_PROGRESS: "reading transactions",
  INVESTMENTS_IN_PROGRESS: "reading investments",
  INVESTMENT_TRANSACTIONS_IN_PROGRESS: "reading investment transactions",
  INVESTMENTS_TRANSACTIONS_IN_PROGRESS: "reading investment transactions",
  LOANS_IN_PROGRESS: "reading loans",
  IDENTITY_IN_PROGRESS: "reading identity",
  PAYMENT_DATA_IN_PROGRESS: "reading payment data",
  ACCOUNT_STATEMENTS_IN_PROGRESS: "reading statements",
  BROKERAGE_NOTE_IN_PROGRESS: "reading brokerage notes",
  MERGING: "merging what changed",
  SUCCESS: "done",
  PARTIAL_SUCCESS: "done, with warnings",
};

/**
 * What to put next to the spinner. An unrecognised stage is shown in the
 * roughest possible English rather than dropped, because the two enums Pluggy
 * publishes do not agree with each other and neither is closed.
 */
export function stageLabel(executionStatus: string | null): string {
  if (executionStatus === null) {
    return "starting";
  }

  return STAGES[executionStatus] ?? executionStatus.toLowerCase().replaceAll("_", " ");
}

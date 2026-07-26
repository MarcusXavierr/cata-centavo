import type { Bank, Connection, RefreshStart } from "../../src/core/contracts.ts";
import { AuthError, NotFoundError } from "../../src/pluggy/errors.ts";

export type FakeBankOptions = {
  readonly connections?: readonly Connection[];
  /** When set, `verifyCredentials` rejects with an `AuthError` carrying it. */
  readonly credentialsRejected?: string;
  /** Ids that fail with something other than "not found". */
  readonly unreachable?: Readonly<Record<string, Error>>;
  /**
   * Successive `getConnection` answers per id, which is what a sync being polled
   * to completion looks like from the outside. The last entry repeats once the
   * script runs out, so a test only writes the states it cares about.
   */
  readonly polls?: Readonly<Record<string, readonly Connection[]>>;
  /** What `refreshConnection` answers per id. An `Error` is thrown instead. */
  readonly refreshes?: Readonly<Record<string, RefreshStart | Error>>;
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
  const unreachable = options.unreachable ?? {};
  const polls = options.polls ?? {};
  const refreshes = options.refreshes ?? {};
  const calls: string[] = [];
  const served: Record<string, number> = {};

  function answer(id: string): Connection {
    const script = polls[id];
    if (script !== undefined && script.length > 0) {
      const at = served[id] ?? 0;
      served[id] = at + 1;
      const found = script[Math.min(at, script.length - 1)];
      if (found !== undefined) {
        return found;
      }
    }

    const found = connections.find((candidate) => candidate.id === id);
    if (found === undefined) {
      throw new NotFoundError("not found — wrong id, or an id from another Pluggy account", 404);
    }

    return found;
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

      const failure = unreachable[id];
      if (failure !== undefined) {
        throw failure;
      }

      return answer(id);
    },

    refreshConnection: async (id) => {
      calls.push(`refresh ${id}`);

      const scripted = refreshes[id];
      if (scripted instanceof Error) {
        throw scripted;
      }
      if (scripted !== undefined) {
        return scripted;
      }

      const failure = unreachable[id];
      if (failure !== undefined) {
        throw failure;
      }

      return { kind: "started", connection: answer(id) };
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

/** Mid-sync, at the stage the argument names. */
export function updating(id: string, executionStatus: string): Connection {
  return connection(id, { status: "UPDATING", executionStatus, lastUpdatedAt: null });
}

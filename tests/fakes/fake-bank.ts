import type { Bank, Connection } from "../../src/core/contracts.ts";
import { AuthError, NotFoundError } from "../../src/pluggy/errors.ts";

export type FakeBankOptions = {
  readonly connections?: readonly Connection[];
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
  const unreachable = options.unreachable ?? {};
  const calls: string[] = [];

  function answer(id: string): Connection {
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

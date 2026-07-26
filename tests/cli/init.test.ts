import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  exitCodeFor,
  formatInit,
  runInit,
  type ConnectionOutcome,
  type InitDeps,
  type InitReport,
} from "../../src/cli/init.ts";
import type { Row } from "../../src/cli/progress.ts";
import { HttpError } from "../../src/pluggy/errors.ts";
import { connection, fakeBank, updating, type FakeBankOptions } from "../fakes/fake-bank.ts";
import { fixedClock } from "../fakes/fixed-clock.ts";

const NOW = new Date("2026-07-25T12:00:00.000Z");
const ID_A = "aaaaaaaa-1111-2222-3333-444444444444";
const ID_B = "bbbbbbbb-1111-2222-3333-444444444444";

const ENV = {
  PLUGGY_CLIENT_ID: "client-id",
  PLUGGY_CLIENT_SECRET: "client-secret",
  PLUGGY_ITEM_IDS: `${ID_A},${ID_B}`,
};

const ONLY_A = { ...ENV, PLUGGY_ITEM_IDS: ID_A };

const STORAGE = {
  cacheDb: "/cache/cata-centavo/cache.db",
  dataDb: "/data/cata-centavo/data.db",
  cacheVersion: 0,
  dataVersion: 0,
};

function deps(env: Record<string, string | undefined>, bank: FakeBankOptions, storageFailure?: Error) {
  const built: string[] = [];
  const prepared: string[] = [];
  const frames: Row[][] = [];
  const instance = fakeBank(bank);

  const initDeps: InitDeps = {
    env,
    createBank: (credentials) => {
      built.push(credentials.clientId);
      return instance;
    },
    prepareStorage: () => {
      prepared.push("prepareStorage");
      if (storageFailure !== undefined) {
        throw storageFailure;
      }
      return STORAGE;
    },
    sleep: async () => {},
    report: (rows) => {
      frames.push([...rows]);
    },
  };

  return { initDeps, built, prepared, instance, frames };
}

/** The report, plus its lines, for the common single-connection case. */
async function report(bank: FakeBankOptions, env = ONLY_A) {
  const { initDeps, instance, frames } = deps(env, bank);
  const result = await runInit(initDeps);

  return { result, instance, frames, text: formatInit(result, fixedClock(NOW)).join("\n") };
}

function outcomes(result: InitReport): readonly ConnectionOutcome[] {
  return result.kind === "checked" ? result.outcomes : [];
}

describe("runInit", () => {
  it("reports config problems without building a client or touching disk", async () => {
    const { initDeps, built, prepared } = deps({}, {});

    const result = await runInit(initDeps);

    assert.equal(result.kind, "config");
    assert.equal(built.length, 0, "constructed a client with no credentials to give it");
    assert.equal(prepared.length, 0, "created database files for a run that cannot proceed");
    assert.equal(exitCodeFor(result), 2);
  });

  it("stops on unusable storage before spending a single request", async () => {
    const { initDeps, instance } = deps(ENV, {}, new Error("data.db is at schema version 4"));

    const result = await runInit(initDeps);

    assert.equal(result.kind, "storage");
    assert.deepEqual(instance.calls, []);
    assert.equal(exitCodeFor(result), 1);
    assert.match(formatInit(result, fixedClock(NOW)).join("\n"), /schema version 4/);
  });

  it("stops at refused credentials instead of asking every bank to sync", async () => {
    const { initDeps, instance } = deps(ENV, { credentialsRejected: "Pluggy refused the credentials" });

    const result = await runInit(initDeps);

    assert.equal(result.kind, "credentials");
    assert.deepEqual(instance.calls, ["verifyCredentials"]);
    assert.equal(exitCodeFor(result), 1);
  });

  it("asks for a sync even when the connection looks fresh", async () => {
    const { instance, result } = await report({
      connections: [connection(ID_A, { lastUpdatedAt: new Date(NOW.getTime() - 60_000) })],
    });

    assert.ok(instance.calls.includes(`refresh ${ID_A}`), "trusted a timestamp instead of asking");
    assert.equal(outcomes(result)[0]?.kind, "refreshed");
  });

  it("refreshes every id it can, and one bad id does not stop the rest", async () => {
    const { initDeps, instance } = deps(ENV, { connections: [connection(ID_A)] });

    const result = await runInit(initDeps);

    assert.ok(instance.calls.includes(`refresh ${ID_A}`));
    assert.ok(!instance.calls.includes(`refresh ${ID_B}`), "asked an unknown id to sync");
    assert.deepEqual(
      outcomes(result).map((outcome) => [outcome.id, outcome.kind]),
      [
        [ID_A, "refreshed"],
        [ID_B, "failed"],
      ],
    );
    assert.equal(exitCodeFor(result), 1);
  });

  it("polls a sync it started through to the end", async () => {
    const { result, instance } = await report({
      polls: {
        [ID_A]: [updating(ID_A, "LOGIN_IN_PROGRESS"), updating(ID_A, "TRANSACTIONS_IN_PROGRESS"), connection(ID_A)],
      },
      refreshes: { [ID_A]: { kind: "started", connection: updating(ID_A, "CREATED") } },
    });

    // One read to validate the id, then two more to follow the sync to UPDATED.
    assert.equal(outcomes(result)[0]?.kind, "refreshed");
    assert.equal(instance.calls.filter((call) => call === ID_A).length, 3, "did not poll to completion");
  });

  it("takes a refusal as already fresh and succeeds", async () => {
    const { result, text } = await report({
      connections: [connection(ID_A)],
      refreshes: {
        [ID_A]: { kind: "too-soon", everyHours: 24, lastUpdatedAt: new Date("2026-07-25T09:00:00.000Z") },
      },
    });

    assert.equal(outcomes(result)[0]?.kind, "already-fresh");
    assert.equal(exitCodeFor(result), 0);
    assert.match(text, /already fresh/);
    assert.match(text, /24h/);
    assert.match(text, /3h ago/);
  });

  it("counts a connector that cannot be refreshed as usable", async () => {
    const { result, text } = await report({
      connections: [connection(ID_A, { institution: "MeuPluggy" })],
      refreshes: { [ID_A]: { kind: "not-refreshable" } },
    });

    assert.equal(outcomes(result)[0]?.kind, "not-refreshable");
    assert.equal(exitCodeFor(result), 0);
    assert.match(text, /MeuPluggy, UPDATED, synced 3h ago/);
    assert.match(text, /cannot be refreshed on demand/);
    assert.match(text, /own schedule/);
    assert.match(text, /1 of 1/);
    assert.doesNotMatch(text, /✗/);
  });

  it("keeps a network failure separate from a wrong id", async () => {
    const { text } = await report(
      {
        connections: [connection(ID_A)],
        unreachable: { [ID_B]: new HttpError("Pluggy returned 503 while resolving connection", 503) },
      },
      ENV,
    );

    assert.match(text, /503/);
    assert.doesNotMatch(text, /wrong id/);
  });
});

describe("runInit progress", () => {
  it("shows what each bank is doing, then leaves an empty screen", async () => {
    const { frames } = await report({
      polls: {
        [ID_A]: [updating(ID_A, "LOGIN_IN_PROGRESS"), updating(ID_A, "TRANSACTIONS_IN_PROGRESS"), connection(ID_A)],
      },
      refreshes: { [ID_A]: { kind: "started", connection: updating(ID_A, "LOGIN_IN_PROGRESS") } },
    });

    const details = frames.flatMap((rows) => rows.map((row) => `${row.label} — ${row.detail}`));
    assert.deepEqual(details, ["Nubank — logging in", "Nubank — reading transactions"]);
    assert.deepEqual(frames.at(-1), [], "left a finished connection on the screen");
  });

  it("names the institution rather than a uuid, since it asked for it first", async () => {
    // The refresh response carries "Nubank"; only the validating read carries
    // "Itaú". The label has to come from the read, or the spinner spends the next
    // several minutes showing a UUID.
    const { frames } = await report({
      polls: { [ID_A]: [connection(ID_A, { institution: "Itaú" })] },
      refreshes: { [ID_A]: { kind: "started", connection: updating(ID_A, "ACCOUNTS_IN_PROGRESS") } },
    });

    assert.equal(frames[0]?.[0]?.label, "Itaú");
  });
});

describe("formatInit", () => {
  it("names each connection, its status and how long ago it synced", async () => {
    const { text } = await report({ connections: [connection(ID_A), connection(ID_B)] }, ENV);

    assert.match(text, /Nubank/);
    assert.match(text, /UPDATED/);
    assert.match(text, new RegExp(ID_A));
    assert.match(text, /2 of 2/);
  });

  it("shows where the two files live and what version they carry", async () => {
    const { text } = await report({ connections: [connection(ID_A)] });

    assert.match(text, /cache\.db/);
    assert.match(text, /data\.db/);
    assert.match(text, /v0/);
  });

  it("prints every warning a partial sync came back with", async () => {
    const warning = "creditCards: Open Finance monthly rate limit reached";
    const { text, result } = await report({
      connections: [connection(ID_A)],
      refreshes: {
        [ID_A]: {
          kind: "started",
          connection: connection(ID_A, { executionStatus: "PARTIAL_SUCCESS", warnings: [warning] }),
        },
      },
    });

    assert.match(text, new RegExp(warning));
    assert.equal(exitCodeFor(result), 0, "a product hitting its quota is not a broken connection");
    assert.match(text, /1 of 1/);
  });

  it("says what the bank is waiting for when it wants a second factor", async () => {
    const { text, result } = await report({
      connections: [connection(ID_A)],
      refreshes: {
        [ID_A]: {
          kind: "started",
          connection: connection(ID_A, {
            status: "WAITING_USER_INPUT",
            executionStatus: "WAITING_USER_INPUT",
            parameter: "Chave de segurança",
          }),
        },
      },
    });

    assert.match(text, /Chave de segurança/);
    assert.equal(exitCodeFor(result), 1);
  });

  it("points a refused login at the only thing that fixes it", async () => {
    const { text } = await report({
      connections: [connection(ID_A)],
      refreshes: {
        [ID_A]: {
          kind: "started",
          connection: connection(ID_A, { status: "LOGIN_ERROR", executionStatus: "INVALID_CREDENTIALS" }),
        },
      },
    });

    assert.match(text, /Pluggy Connect/);
  });

  it("says a sync is still running rather than calling it broken", async () => {
    const { text, result } = await report({
      polls: { [ID_A]: [updating(ID_A, "TRANSACTIONS_IN_PROGRESS")] },
      refreshes: { [ID_A]: { kind: "started", connection: updating(ID_A, "CREATED") } },
    });

    assert.equal(outcomes(result)[0]?.kind, "still-updating");
    assert.match(text, /still/);
    assert.doesNotMatch(text, /never synced/);
  });

  it("says so plainly when a connection has never synced", async () => {
    const { text } = await report({
      connections: [connection(ID_A, { lastUpdatedAt: null })],
      refreshes: { [ID_A]: { kind: "started", connection: connection(ID_A, { lastUpdatedAt: null }) } },
    });

    assert.match(text, /never synced/);
    assert.doesNotMatch(text, /NaN|Invalid/);
  });

  it("lists every config problem, one per line", async () => {
    const { initDeps } = deps({}, {});

    const text = formatInit(await runInit(initDeps), fixedClock(NOW)).join("\n");

    assert.match(text, /PLUGGY_CLIENT_ID/);
    assert.match(text, /PLUGGY_CLIENT_SECRET/);
    assert.match(text, /PLUGGY_ITEM_IDS/);
  });

  it("never prints a credential value", async () => {
    const { text } = await report({ credentialsRejected: "Pluggy refused the credentials" }, ENV);

    assert.doesNotMatch(text, /client-secret/);
  });
});

describe("exitCodeFor", () => {
  it("counts a refresh and a refusal as success and everything else as failure", () => {
    const cases: readonly { readonly outcome: ConnectionOutcome; readonly expected: number }[] = [
      { outcome: { kind: "refreshed", id: ID_A, connection: connection(ID_A) }, expected: 0 },
      { outcome: { kind: "already-fresh", id: ID_A, connection: connection(ID_A), everyHours: 24 }, expected: 0 },
      { outcome: { kind: "not-refreshable", id: ID_A, connection: connection(ID_A) }, expected: 0 },
      { outcome: { kind: "needs-user", id: ID_A, connection: connection(ID_A) }, expected: 1 },
      { outcome: { kind: "login-error", id: ID_A, connection: connection(ID_A) }, expected: 1 },
      { outcome: { kind: "still-updating", id: ID_A, connection: connection(ID_A) }, expected: 1 },
      { outcome: { kind: "failed", id: ID_A, institution: null, reason: "not found" }, expected: 1 },
    ];

    for (const { outcome, expected } of cases) {
      assert.equal(
        exitCodeFor({ kind: "checked", storage: STORAGE, outcomes: [outcome] }),
        expected,
        outcome.kind,
      );
    }
  });
});

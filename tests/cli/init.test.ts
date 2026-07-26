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
import { HttpError } from "../../src/pluggy/errors.ts";
import { connection, fakeBank, type FakeBankOptions } from "../fakes/fake-bank.ts";
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
  };

  return { initDeps, built, prepared, instance };
}

/** The report, plus its lines, for the common single-connection case. */
async function report(bank: FakeBankOptions, env = ONLY_A) {
  const { initDeps, instance } = deps(env, bank);
  const result = await runInit(initDeps);

  return { result, instance, text: formatInit(result, fixedClock(NOW)).join("\n") };
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

  it("stops at refused credentials instead of reading every connection", async () => {
    const { initDeps, instance } = deps(ENV, { credentialsRejected: "Pluggy refused the credentials" });

    const result = await runInit(initDeps);

    assert.equal(result.kind, "credentials");
    assert.deepEqual(instance.calls, ["verifyCredentials"]);
    assert.equal(exitCodeFor(result), 1);
  });

  it("reads every configured id, and one bad id does not stop the rest", async () => {
    const { initDeps, instance } = deps(ENV, { connections: [connection(ID_A)] });

    const result = await runInit(initDeps);

    assert.ok(instance.calls.includes(ID_A));
    assert.ok(instance.calls.includes(ID_B), "gave up before reading the second id");
    assert.deepEqual(
      outcomes(result).map((outcome) => [outcome.id, outcome.kind]),
      [
        [ID_A, "usable"],
        [ID_B, "failed"],
      ],
    );
    assert.equal(exitCodeFor(result), 1);
  });

  it("reads each connection once, since nothing is waited on", async () => {
    const { instance, result } = await report({ connections: [connection(ID_A)] });

    assert.deepEqual(instance.calls, ["verifyCredentials", ID_A]);
    assert.equal(outcomes(result)[0]?.kind, "usable");
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

describe("formatInit", () => {
  it("names each connection, its status and how long ago it synced", async () => {
    const { text } = await report({ connections: [connection(ID_A), connection(ID_B)] }, ENV);

    assert.match(text, /Nubank/);
    assert.match(text, /UPDATED/);
    assert.match(text, new RegExp(ID_A));
    assert.match(text, /synced 3h ago/);
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
      connections: [connection(ID_A, { executionStatus: "PARTIAL_SUCCESS", warnings: [warning] })],
    });

    assert.match(text, new RegExp(warning));
    assert.match(text, /^!/m, "a quota warning was reported as an unqualified success");
    assert.equal(exitCodeFor(result), 0, "a product hitting its quota is not a broken connection");
    assert.match(text, /1 of 1/);
  });

  it("says what the bank is waiting for, without calling the connection broken", async () => {
    const { text, result } = await report({
      connections: [
        connection(ID_A, {
          status: "WAITING_USER_INPUT",
          executionStatus: "WAITING_USER_INPUT",
          lastUpdatedAt: null,
          parameter: "Chave de segurança",
        }),
      ],
    });

    assert.match(text, /WAITING_USER_INPUT, never synced — the bank is waiting on you: Chave de segurança/);
    assert.equal(exitCodeFor(result), 0, "a readable connection failed over a fact about the bank");
  });

  it("says so plainly when a connection has never synced", async () => {
    const { text } = await report({ connections: [connection(ID_A, { lastUpdatedAt: null })] });

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
  it("counts a readable connection as success and an unreadable one as failure", () => {
    const cases: readonly { readonly outcome: ConnectionOutcome; readonly expected: number }[] = [
      { outcome: { kind: "usable", id: ID_A, connection: connection(ID_A) }, expected: 0 },
      { outcome: { kind: "failed", id: ID_A, reason: "not found" }, expected: 1 },
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

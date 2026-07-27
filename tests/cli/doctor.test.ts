import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  exitCodeFor,
  formatDoctor,
  runDoctor,
  type DoctorDeps,
  type DoctorReport,
  type LocalState,
} from "../../src/cli/doctor.ts";
import { toFailure } from "../../src/pluggy/errors.ts";
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

function localState(overrides: Partial<LocalState> = {}): LocalState {
  return {
    cacheDb: "/cache/cata-centavo/cache.db",
    dataDb: "/data/cata-centavo/data.db",
    cacheVersion: 2,
    dataVersion: 1,
    accountsWalked: 0,
    newestLocalDate: null,
    perConnection: new Map(),
    snapshotRows: 0,
    counterpartyDocuments: 0,
    mccRows: 0,
    ...overrides,
  };
}

function deps(
  env: Record<string, string | undefined>,
  bank: FakeBankOptions,
  state: LocalState = localState(),
  storageFailure?: Error,
) {
  const built: string[] = [];
  const readCalls: string[] = [];
  const instance = fakeBank(bank);

  const doctorDeps: DoctorDeps = {
    env,
    createBank: (credentials) => {
      built.push(credentials.clientId);
      return instance;
    },
    readLocalState: () => {
      readCalls.push("readLocalState");
      if (storageFailure !== undefined) {
        throw storageFailure;
      }
      return state;
    },
    toFailure,
    clock: fixedClock(NOW),
  };

  return { doctorDeps, built, readCalls, instance };
}

async function report(bank: FakeBankOptions, state?: LocalState, env = ONLY_A) {
  const { doctorDeps, instance } = deps(env, bank, state);
  const result = await runDoctor(doctorDeps);
  return { result, instance, text: formatDoctor(result, fixedClock(NOW)).join("\n") };
}

describe("runDoctor", () => {
  it("reports config problems without touching storage or building a client", async () => {
    const { doctorDeps, built, readCalls } = deps({}, {});

    const result = await runDoctor(doctorDeps);

    assert.equal(result.kind, "config");
    assert.equal(built.length, 0);
    assert.equal(readCalls.length, 0);
    assert.equal(exitCodeFor(result), 2);
  });

  it("stops on unreadable storage before building a client", async () => {
    const { doctorDeps, built } = deps(ENV, {}, localState(), new Error("data.db is at schema version 4"));

    const result = await runDoctor(doctorDeps);

    assert.equal(result.kind, "storage");
    assert.equal(built.length, 0);
    assert.equal(exitCodeFor(result), 1);
    assert.match(formatDoctor(result, fixedClock(NOW)).join("\n"), /schema version 4/);
  });

  it("stops at refused credentials before diagnosing any connection", async () => {
    const { doctorDeps, instance } = deps(ENV, { credentialsRejected: "Pluggy refused the credentials" });

    const result = await runDoctor(doctorDeps);

    assert.equal(result.kind, "credentials");
    assert.deepEqual(instance.calls, ["verifyCredentials"]);
    assert.equal(exitCodeFor(result), 1);
  });

  it("diagnoses every configured id, and one bad id does not stop the rest", async () => {
    const { doctorDeps, instance } = deps(ENV, { connections: [connection(ID_A)] });

    const result = await runDoctor(doctorDeps);

    assert.equal(result.kind, "checked");
    assert.ok(instance.calls.some((call) => call === ID_A));
    assert.ok(instance.calls.some((call) => call === ID_B));
  });
});

describe("exitCodeFor", () => {
  it("exits 0 when every connection is usable", async () => {
    const { result } = await report({ connections: [connection(ID_A), connection(ID_B)] }, undefined, ENV);

    assert.equal(exitCodeFor(result), 0);
  });

  it("exits 1 when a connection could not be read", async () => {
    const { result } = await report(
      { connections: [connection(ID_A)], unreachable: { [ID_B]: new Error("Pluggy returned 503") } },
      undefined,
      ENV,
    );

    assert.equal(exitCodeFor(result), 1);
  });

  it("exits 1 when a connection's consent was revoked", async () => {
    const { result } = await report({
      connections: [connection(ID_A)],
      consents: { [ID_A]: { expiresAt: null, revokedAt: new Date("2026-07-20T00:00:00.000Z"), products: [] } },
    });

    assert.equal(exitCodeFor(result), 1);
  });

  it("exits 1 when a connection's consent expired", async () => {
    const { result } = await report({
      connections: [connection(ID_A)],
      consents: { [ID_A]: { expiresAt: new Date("2026-07-10T00:00:00.000Z"), revokedAt: null, products: [] } },
    });

    assert.equal(exitCodeFor(result), 1);
  });

  it("exits 0 when a connection reported PARTIAL_SUCCESS warnings but is otherwise active", async () => {
    const { result } = await report({
      connections: [connection(ID_A, { executionStatus: "PARTIAL_SUCCESS", warnings: ["creditCards: quota reached"] })],
    });

    assert.equal(exitCodeFor(result), 0);
  });

  it("exits 0 on a checked report with zero configured connections", () => {
    const checked: DoctorReport = { kind: "checked", localState: localState(), diagnoses: [] };

    assert.equal(exitCodeFor(checked), 0);
  });
});

describe("formatDoctor", () => {
  it("marks a usable connection with a check, names its institution, status, sync time and consent", async () => {
    const { text } = await report({
      connections: [connection(ID_A)],
      consents: { [ID_A]: { expiresAt: null, revokedAt: null, products: ["ACCOUNTS"] } },
    });

    assert.match(text, /connections/);
    assert.match(text, new RegExp(`✓ ${ID_A}.*Nubank.*UPDATED.*synced 3h ago`));
    assert.match(text, /consent: active, 1 products/);
  });

  it("marks a connection carrying warnings with ! rather than a bare check", async () => {
    const { text } = await report({
      connections: [connection(ID_A, { executionStatus: "PARTIAL_SUCCESS", warnings: ["creditCards: quota reached"] })],
    });

    assert.match(text, new RegExp(`! ${ID_A}`));
    assert.match(text, /creditCards: quota reached/);
  });

  it("marks a revoked connection with a cross and names the date", async () => {
    const { text } = await report({
      connections: [connection(ID_A)],
      consents: { [ID_A]: { expiresAt: null, revokedAt: new Date("2026-07-20T00:00:00.000Z"), products: [] } },
    });

    assert.match(text, new RegExp(`✗ ${ID_A}.*consent revoked on 2026-07-20.*re-link`));
  });

  it("marks an expired connection with a cross and names the date", async () => {
    const { text } = await report({
      connections: [connection(ID_A)],
      consents: { [ID_A]: { expiresAt: new Date("2026-07-10T00:00:00.000Z"), revokedAt: null, products: [] } },
    });

    assert.match(text, new RegExp(`✗ ${ID_A}.*consent expired on 2026-07-10`));
  });

  it("marks a connection that could not be read with a cross and the failure reason", async () => {
    const { text } = await report({ unreachable: { [ID_A]: new Error("Pluggy returned 503") } });

    assert.match(text, new RegExp(`✗ ${ID_A}.*Pluggy returned 503`));
  });

  it("reports consent as unknown when the endpoint answered with nothing at all", async () => {
    const { text } = await report({ connections: [connection(ID_A)] });

    assert.match(text, /consent: unknown/);
  });

  it("shows where the two files live and what version they carry", async () => {
    const { text } = await report({ connections: [connection(ID_A)] });

    assert.match(text, /storage/);
    assert.match(text, /cache\.db/);
    assert.match(text, /data\.db/);
    assert.match(text, /v2/);
    assert.match(text, /v1/);
  });

  it("summarizes the cache: accounts walked, newest transaction, and per connection", async () => {
    const state = localState({
      accountsWalked: 6,
      newestLocalDate: "2026-07-25",
      perConnection: new Map([[ID_A, { accounts: 2, oldestWalk: "2026-07-22T12:00:00.000Z" }]]),
    });
    const { text } = await report({ connections: [connection(ID_A)] }, state);

    assert.match(text, /cache/);
    assert.match(text, /6 accounts walked/);
    assert.match(text, /newest transaction 2026-07-25/);
    assert.match(text, new RegExp(`${ID_A}.*2 accounts.*oldest walk 3d ago`));
  });

  it("summarizes the categorization tables", async () => {
    const state = localState({ snapshotRows: 1748, counterpartyDocuments: 312, mccRows: 1200 });
    const { text } = await report({ connections: [connection(ID_A)] }, state);

    assert.match(text, /categorization/);
    assert.match(text, /1748/);
    assert.match(text, /312/);
    assert.match(text, /merchant codes present/);
  });

  it("counts usable connections in the summary line", async () => {
    const { text } = await report(
      { connections: [connection(ID_A)], unreachable: { [ID_B]: new Error("Pluggy returned 503") } },
      undefined,
      ENV,
    );

    assert.match(text, /1 of 2 connections are usable/);
  });

  it("still shows storage and cache blocks when credentials are refused", async () => {
    const { doctorDeps } = deps(ENV, { credentialsRejected: "Pluggy refused the credentials" }, localState());
    const result = await runDoctor(doctorDeps);

    const text = formatDoctor(result, fixedClock(NOW)).join("\n");

    assert.match(text, /cache\.db/);
    assert.match(text, /Pluggy refused the credentials/);
  });

  it("never prints a credential value", async () => {
    const { doctorDeps } = deps(ENV, { credentialsRejected: "Pluggy refused the credentials" });
    const result = await runDoctor(doctorDeps);

    const text = formatDoctor(result, fixedClock(NOW)).join("\n");

    assert.doesNotMatch(text, /client-secret/);
  });

  it("lists every config problem, one per line", () => {
    const report: DoctorReport = {
      kind: "config",
      problems: ["PLUGGY_CLIENT_ID is missing or empty.", "PLUGGY_CLIENT_SECRET is missing or empty."],
    };

    const text = formatDoctor(report, fixedClock(NOW)).join("\n");

    assert.match(text, /PLUGGY_CLIENT_ID/);
    assert.match(text, /PLUGGY_CLIENT_SECRET/);
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { RefreshEvent } from "../../src/core/refresh.ts";
import { POLL, phaseOf, refresh, stageLabel } from "../../src/core/refresh.ts";
import { HttpError } from "../../src/pluggy/errors.ts";
import { connection, fakeBank, updating, type FakeBankOptions } from "../fakes/fake-bank.ts";

const ID = "aaaaaaaa-1111-2222-3333-444444444444";

function harness(options: FakeBankOptions) {
  const bank = fakeBank(options);
  const slept: number[] = [];
  const events: RefreshEvent[] = [];

  return {
    bank,
    slept,
    events,
    deps: {
      bank,
      sleep: async (milliseconds: number) => {
        slept.push(milliseconds);
      },
      report: (event: RefreshEvent) => {
        events.push(event);
      },
    },
  };
}

/** The stages a healthy Open Finance sync walks through. */
function script(...stages: readonly string[]) {
  return [...stages.map((stage) => updating(ID, stage)), connection(ID)];
}

describe("refresh", () => {
  it("polls until the sync succeeds", async () => {
    const { deps, slept } = harness({
      polls: { [ID]: script("LOGIN_IN_PROGRESS", "ACCOUNTS_IN_PROGRESS", "TRANSACTIONS_IN_PROGRESS") },
      refreshes: { [ID]: { kind: "started", connection: updating(ID, "CREATED") } },
    });

    const outcome = await refresh(deps, ID);

    assert.equal(outcome.kind, "refreshed");
    assert.equal(slept.length, 4, "polled a different number of times than it slept");
  });

  it("accepts PARTIAL_SUCCESS as a refresh, carrying its warnings", async () => {
    const warning = "Open Finance monthly rate limit reached on product 'accounts'";
    const { deps } = harness({
      polls: {
        [ID]: [
          updating(ID, "ACCOUNTS_IN_PROGRESS"),
          connection(ID, { status: "UPDATED", executionStatus: "PARTIAL_SUCCESS", warnings: [warning] }),
        ],
      },
      refreshes: { [ID]: { kind: "started", connection: updating(ID, "CREATED") } },
    });

    const outcome = await refresh(deps, ID);

    assert.equal(outcome.kind, "refreshed");
    assert.deepEqual(outcome.kind === "refreshed" ? outcome.connection.warnings : [], [warning]);
  });

  it("does not poll at all when the trigger already came back terminal", async () => {
    const { deps, slept, bank } = harness({
      refreshes: { [ID]: { kind: "started", connection: connection(ID) } },
    });

    const outcome = await refresh(deps, ID);

    assert.equal(outcome.kind, "refreshed");
    assert.deepEqual(slept, []);
    assert.deepEqual(bank.calls, [`refresh ${ID}`]);
  });

  it("reads a refusal as already fresh rather than as a failure", async () => {
    const lastUpdatedAt = new Date("2026-07-25T09:00:00.000Z");
    const { deps, slept } = harness({
      refreshes: { [ID]: { kind: "too-soon", everyHours: 24, lastUpdatedAt } },
    });

    const outcome = await refresh(deps, ID);

    assert.equal(outcome.kind, "already-fresh");
    assert.equal(outcome.kind === "already-fresh" ? outcome.everyHours : null, 24);
    assert.deepEqual(outcome.kind === "already-fresh" ? outcome.lastUpdatedAt : null, lastUpdatedAt);
    assert.deepEqual(slept, [], "waited for a sync that was never triggered");
  });

  it("carries a connector that cannot be refreshed through as its own outcome", async () => {
    const { deps, slept, bank } = harness({
      refreshes: { [ID]: { kind: "not-refreshable" } },
    });

    const outcome = await refresh(deps, ID);

    assert.deepEqual(outcome, { kind: "not-refreshable" });
    assert.deepEqual(slept, [], "polled a sync that was never started");
    assert.deepEqual(bank.calls, [`refresh ${ID}`]);
  });

  it("stops when the bank wants a second factor, naming what it wants", async () => {
    const { deps } = harness({
      polls: {
        [ID]: [
          updating(ID, "LOGIN_MFA_IN_PROGRESS"),
          connection(ID, {
            status: "WAITING_USER_INPUT",
            executionStatus: "WAITING_USER_INPUT",
            parameter: "Chave de segurança",
          }),
        ],
      },
      refreshes: { [ID]: { kind: "started", connection: updating(ID, "CREATED") } },
    });

    const outcome = await refresh(deps, ID);

    assert.equal(outcome.kind, "needs-user");
    assert.equal(outcome.kind === "needs-user" ? outcome.connection.parameter : null, "Chave de segurança");
  });

  it("stops on a login error instead of retrying credentials that will not work", async () => {
    const { deps, slept } = harness({
      refreshes: {
        [ID]: {
          kind: "started",
          connection: connection(ID, { status: "LOGIN_ERROR", executionStatus: "INVALID_CREDENTIALS" }),
        },
      },
    });

    const outcome = await refresh(deps, ID);

    assert.equal(outcome.kind, "login-error");
    assert.deepEqual(slept, []);
  });

  it("names the raw pair when the status is one we have never seen", async () => {
    const { deps } = harness({
      refreshes: {
        [ID]: { kind: "started", connection: connection(ID, { status: "SPONTANEOUS", executionStatus: "WAT" }) },
      },
    });

    const outcome = await refresh(deps, ID);

    assert.equal(outcome.kind, "failed");
    const reason = outcome.kind === "failed" ? outcome.reason : "";
    assert.match(reason, /SPONTANEOUS/);
    assert.match(reason, /WAT/);
  });

  it("gives up after a bounded number of polls, without calling it a failure", async () => {
    const { deps, slept } = harness({
      polls: { [ID]: [updating(ID, "TRANSACTIONS_IN_PROGRESS")] },
      refreshes: { [ID]: { kind: "started", connection: updating(ID, "CREATED") } },
    });

    const outcome = await refresh(deps, ID);

    assert.equal(outcome.kind, "still-updating");
    assert.equal(slept.length, POLL.attempts);
  });

  it("backs off from 2s, doubling, capped at 30s", async () => {
    const { deps, slept } = harness({
      polls: { [ID]: [updating(ID, "TRANSACTIONS_IN_PROGRESS")] },
      refreshes: { [ID]: { kind: "started", connection: updating(ID, "CREATED") } },
    });

    await refresh(deps, ID);

    assert.deepEqual(slept.slice(0, 6), [2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
    assert.equal(Math.max(...slept), POLL.maxDelayMs);
  });

  it("reports a stage when it changes and not once more", async () => {
    const { deps, events } = harness({
      polls: {
        [ID]: [
          updating(ID, "LOGIN_IN_PROGRESS"),
          updating(ID, "LOGIN_IN_PROGRESS"),
          updating(ID, "TRANSACTIONS_IN_PROGRESS"),
          connection(ID),
        ],
      },
      refreshes: { [ID]: { kind: "started", connection: updating(ID, "LOGIN_IN_PROGRESS") } },
    });

    await refresh(deps, ID);

    assert.deepEqual(
      events.map((event) => (event.kind === "stage" ? event.label : `settled ${event.id}`)),
      ["logging in", "reading transactions", `settled ${ID}`],
    );
  });

  it("surfaces a transport failure as a failure, with its message", async () => {
    const { deps } = harness({
      refreshes: { [ID]: new HttpError("Pluggy returned 503 while refreshing", 503) },
    });

    const outcome = await refresh(deps, ID);

    assert.equal(outcome.kind, "failed");
    assert.match(outcome.kind === "failed" ? outcome.reason : "", /503/);
  });

  it("settles every refresh, whatever the outcome", async () => {
    const { deps, events } = harness({
      refreshes: { [ID]: new HttpError("Pluggy returned 503 while refreshing", 503) },
    });

    await refresh(deps, ID);

    assert.deepEqual(events, [{ kind: "settled", id: ID }]);
  });
});

describe("phaseOf", () => {
  it("classifies every status we know and terminates on the ones we do not", () => {
    const cases = [
      { status: "UPDATING", executionStatus: "ACCOUNTS_IN_PROGRESS", expected: "updating" },
      { status: "UPDATED", executionStatus: "SUCCESS", expected: "refreshed" },
      { status: "UPDATED", executionStatus: "PARTIAL_SUCCESS", expected: "refreshed" },
      { status: "UPDATED", executionStatus: null, expected: "refreshed" },
      { status: "PARTIAL_SUCCESS", executionStatus: "PARTIAL_SUCCESS", expected: "refreshed" },
      { status: "WAITING_USER_INPUT", executionStatus: "WAITING_USER_INPUT", expected: "needs-user" },
      { status: "WAITING_USER_ACTION", executionStatus: "WAITING_USER_ACTION", expected: "needs-user" },
      { status: "LOGIN_ERROR", executionStatus: "INVALID_CREDENTIALS", expected: "login-error" },
      { status: "OUTDATED", executionStatus: "SITE_NOT_AVAILABLE", expected: "failed" },
      { status: "MERGING", executionStatus: "MERGING", expected: "updating" },
      { status: "WHAT_IS_THIS", executionStatus: null, expected: "failed" },
    ];

    for (const { status, executionStatus, expected } of cases) {
      assert.equal(
        phaseOf(connection(ID, { status, executionStatus })),
        expected,
        `${status} / ${String(executionStatus)}`,
      );
    }
  });
});

describe("stageLabel", () => {
  it("says what the bank is doing in words a human uses", () => {
    const cases = [
      { executionStatus: null, expected: "starting" },
      { executionStatus: "CREATED", expected: "starting" },
      { executionStatus: "LOGIN_IN_PROGRESS", expected: "logging in" },
      { executionStatus: "ACCOUNTS_IN_PROGRESS", expected: "reading accounts" },
      { executionStatus: "CREDITCARDS_IN_PROGRESS", expected: "reading credit cards" },
      { executionStatus: "TRANSACTIONS_IN_PROGRESS", expected: "reading transactions" },
      // The docs and the SDK disagree on this one's spelling, so both are here.
      { executionStatus: "INVESTMENT_TRANSACTIONS_IN_PROGRESS", expected: "reading investment transactions" },
      { executionStatus: "INVESTMENTS_TRANSACTIONS_IN_PROGRESS", expected: "reading investment transactions" },
      { executionStatus: "SUCCESS", expected: "done" },
      { executionStatus: "PARTIAL_SUCCESS", expected: "done, with warnings" },
    ];

    for (const { executionStatus, expected } of cases) {
      assert.equal(stageLabel(executionStatus), expected, String(executionStatus));
    }
  });

  it("shows an unknown stage rather than swallowing it", () => {
    assert.equal(stageLabel("PIX_KEYS_IN_PROGRESS"), "pix keys in progress");
  });
});

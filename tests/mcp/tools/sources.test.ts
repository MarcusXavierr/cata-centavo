import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { connection, threeConnections } from "../../fakes/fake-bank.ts";
import { fakeLogger } from "../../fakes/fake-logger.ts";
import { fakeSource } from "../../fakes/fake-source.ts";
import type { Source } from "../../../src/mcp/source.ts";
import { handleListSources, registerListSources } from "../../../src/mcp/tools/sources.ts";

function payload(result: { readonly content: readonly { readonly type: string; readonly text?: string }[] }): {
  sources: readonly Record<string, unknown>[];
} {
  const first = result.content[0];
  assert.ok(first !== undefined);
  assert.equal(first.type, "text");
  assert.ok(first.text !== undefined);
  return JSON.parse(first.text) as { sources: readonly Record<string, unknown>[] };
}

function message(result: { readonly content: readonly { readonly type: string; readonly text?: string }[] }): string {
  const first = result.content[0];
  assert.ok(first !== undefined);
  assert.equal(first.type, "text");
  assert.ok(first.text !== undefined);
  return first.text;
}

function deps(source: Source, log: ReturnType<typeof fakeLogger>) {
  let reader = null;
  let writer = null;
  if (source.ok) {
    reader = source.reader;
    writer = source.writer;
  }
  return { source, log, reader, writer, clock: { now: () => new Date("2026-07-25T12:00:00.000Z") } };
}

describe("listSources", () => {
  const log = fakeLogger();

  it("mentions what it cannot see, not just what it does", () => {
    const registrations: { description: string }[] = [];
    const server = {
      registerTool(_name: string, options: { readonly description: string }): void {
        registrations.push(options);
      },
    };

    registerListSources(server as never, deps(fakeSource(), log));

    assert.equal(registrations.length, 1);
    assert.match(registrations[0]?.description ?? "", /not what exists in your Pluggy account/i);
  });

  it("reports every field, including a zero failedLogins and an empty warnings list", async () => {
    const source = fakeSource({
      connections: [connection("conn-1", { warnings: [], failedLogins: 0 })],
      accounts: { "conn-1": threeConnections().accounts["conn-1"] ?? [] },
      consents: { "conn-1": { expiresAt: null, revokedAt: null, products: ["ACCOUNTS"] } },
    });

    const result = await handleListSources(deps(source, log));

    assert.equal(result.isError, undefined);
    const { sources } = payload(result);
    assert.deepEqual(sources, [
      {
        id: "conn-1",
        institution: "Nubank",
        status: "UPDATED",
        executionStatus: "SUCCESS",
        lastUpdatedAt: "2026-07-25T09:00:00.000Z",
        warnings: [],
        failedLogins: 0,
        consent: { state: "active", products: ["ACCOUNTS"] },
      },
    ]);
  });

  it("renders a revoked consent's state without erroring", async () => {
    const source = fakeSource({
      connections: [connection("conn-1")],
      consents: { "conn-1": { expiresAt: null, revokedAt: new Date("2026-07-20T00:00:00.000Z"), products: [] } },
    });

    const result = await handleListSources(deps(source, log));

    assert.equal(result.isError, undefined);
    const { sources } = payload(result);
    assert.equal(sources[0]?.["consent"] && (sources[0]["consent"] as { state: string }).state, "revoked");
  });

  it("stays an ordinary result even when every connection is unreachable", async () => {
    const source = fakeSource({
      connections: [connection("conn-1"), connection("conn-2")],
      unreachable: {
        "conn-1": new Error("Nubank is unavailable"),
        "conn-2": new Error("Nubank is unavailable"),
      },
    });

    const result = await handleListSources(deps(source, log));

    assert.equal(result.isError, undefined);
    const { sources } = payload(result);
    assert.equal(sources.length, 2);
    assert.equal(sources.every((entry) => entry["institution"] === undefined), true);
    assert.equal(sources.every((entry) => typeof entry["failure"] === "object"), true);
  });

  it("reports the configuration problems when the source is broken", async () => {
    const result = await handleListSources(
      deps({ ok: false, problems: ["PLUGGY_CLIENT_SECRET is missing or empty."] }, log),
    );

    assert.equal(result.isError, true);
    assert.match(message(result), /PLUGGY_CLIENT_SECRET/);
  });
});

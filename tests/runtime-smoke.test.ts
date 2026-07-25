import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

/**
 * These tests exercise none of our own code. They prove the ADR's assumptions
 * about the runtime and about our dependencies hold on this machine — now,
 * rather than midway through Phase 0.5.
 */

describe("node:sqlite", () => {
  it("opens an in-memory database with no native dependency (ADR §10)", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    db.prepare("INSERT INTO t (id) VALUES (?)").run(1);

    // node:sqlite returns null-prototype objects, and assert/strict's deepEqual
    // compares prototypes too. Spreading normalizes to a plain object.
    const row = db.prepare("SELECT id FROM t").get();
    assert.deepEqual({ ...row }, { id: 1 });

    db.close();
  });

  it("persists PRAGMA user_version — the basis of the migration strategy (ADR §10)", () => {
    const db = new DatabaseSync(":memory:");

    assert.equal(db.prepare("PRAGMA user_version").get()?.["user_version"], 0);

    db.exec("PRAGMA user_version = 3");
    assert.equal(db.prepare("PRAGMA user_version").get()?.["user_version"], 3);

    db.close();
  });

  it("supports ATTACH, so the two files of §10 can be JOINed", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("ATTACH DATABASE ':memory:' AS userdata");
    db.exec("CREATE TABLE main.tx (id TEXT PRIMARY KEY)");
    db.exec("CREATE TABLE userdata.override (tx_id TEXT PRIMARY KEY, category TEXT)");
    db.exec("INSERT INTO main.tx VALUES ('a')");
    db.exec("INSERT INTO userdata.override VALUES ('a', 'mercado')");

    const row = db
      .prepare(
        `SELECT t.id, (SELECT o.category FROM userdata.override o WHERE o.tx_id = t.id) AS category
         FROM main.tx t`,
      )
      .get();
    assert.deepEqual({ ...row }, { id: "a", category: "mercado" });

    db.close();
  });
});

describe("dependency interop", () => {
  /**
   * pluggy-sdk is CJS-only and re-exports everything through the `__exportStar`
   * helper. Since our package is "type": "module", the named import only works
   * if Node's cjs-module-lexer sees through that indirection. If this test ever
   * fails, the symptom is `does not provide an export named 'PluggyClient'`, and
   * the way out is the default import (`import pluggy from "pluggy-sdk"`),
   * isolated inside src/pluggy/client.ts.
   */
  it("exposes PluggyClient as a named import from ESM", async () => {
    const { PluggyClient } = await import("pluggy-sdk");
    assert.equal(typeof PluggyClient, "function");
  });

  it("exposes McpServer from the MCP SDK", async () => {
    const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
    assert.equal(typeof McpServer, "function");
  });
});

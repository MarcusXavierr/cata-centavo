import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";

import { openDatabase, SchemaTooNewError, type Migration } from "../../src/storage/db.ts";

const V1: Migration = { to: 1, up: "CREATE TABLE note (id INTEGER PRIMARY KEY, body TEXT)" };
const V2: Migration = { to: 2, up: "CREATE TABLE tag (id INTEGER PRIMARY KEY)" };

const roots: string[] = [];

after(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function tempPath(name: string): string {
  const root = mkdtempSync(join(tmpdir(), "cata-centavo-test-"));
  roots.push(root);
  return join(root, name);
}

function userVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get();
  return Number(row?.["user_version"]);
}

function tableNames(db: DatabaseSync): string[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => String(row["name"]));
}

function countNotes(db: DatabaseSync): number {
  return Number(db.prepare("SELECT COUNT(*) AS n FROM note").get()?.["n"]);
}

describe("openDatabase", () => {
  it("creates the file, runs the chain and stamps the version", () => {
    const db = openDatabase({ path: tempPath("data.db"), migrations: [V1, V2], policy: "migrate" });

    assert.equal(userVersion(db), 2);
    assert.deepEqual(tableNames(db), ["note", "tag"]);

    db.close();
  });

  it("applies the pragmas a single local writer needs", () => {
    const db = openDatabase({ path: tempPath("data.db"), migrations: [V1], policy: "migrate" });

    assert.equal(String(db.prepare("PRAGMA journal_mode").get()?.["journal_mode"]).toLowerCase(), "wal");
    assert.equal(Number(db.prepare("PRAGMA busy_timeout").get()?.["timeout"]), 5000);

    db.close();
  });

  it("creates the file readable only by its owner (ADR §9)", { skip: process.platform === "win32" }, () => {
    const path = tempPath("cache.db");
    const db = openDatabase({ path, migrations: [V1], policy: "rebuild" });

    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(`${path}-wal`).mode & 0o777, 0o600, "the WAL sibling leaks what the db protects");

    db.close();
  });

  it("does nothing on reopen when the version already matches", () => {
    const path = tempPath("data.db");

    const first = openDatabase({ path, migrations: [V1], policy: "migrate" });
    first.prepare("INSERT INTO note (body) VALUES (?)").run("kept");
    first.close();

    const second = openDatabase({ path, migrations: [V1], policy: "migrate" });
    assert.equal(userVersion(second), 1);
    assert.equal(countNotes(second), 1);
    second.close();
  });

  it("migrates data forward without touching the rows already there", () => {
    const path = tempPath("data.db");

    const before = openDatabase({ path, migrations: [V1], policy: "migrate" });
    before.prepare("INSERT INTO note (body) VALUES (?)").run("irreplaceable");
    before.close();

    const after_ = openDatabase({ path, migrations: [V1, V2], policy: "migrate" });
    assert.equal(userVersion(after_), 2);
    assert.equal(countNotes(after_), 1, "a data.db migration lost a row");
    assert.ok(tableNames(after_).includes("tag"));
    after_.close();
  });

  it("refuses a data file written by a newer version instead of guessing", () => {
    const path = tempPath("data.db");

    const newer = openDatabase({ path, migrations: [V1, V2], policy: "migrate" });
    newer.close();

    assert.throws(() => openDatabase({ path, migrations: [V1], policy: "migrate" }), SchemaTooNewError);
  });

  it("drops and rebuilds the cache when the version moves", () => {
    const path = tempPath("cache.db");

    const before = openDatabase({ path, migrations: [V1], policy: "rebuild" });
    before.prepare("INSERT INTO note (body) VALUES (?)").run("disposable");
    before.close();

    const after_ = openDatabase({ path, migrations: [V1, V2], policy: "rebuild" });
    assert.equal(userVersion(after_), 2);
    assert.equal(countNotes(after_), 0, "the cache kept rows across a schema change");
    assert.deepEqual(tableNames(after_), ["note", "tag"]);
    after_.close();
  });

  it("rebuilds a cache file from a newer version rather than refusing it", () => {
    const path = tempPath("cache.db");

    const newer = openDatabase({ path, migrations: [V1, V2], policy: "rebuild" });
    newer.close();

    const older = openDatabase({ path, migrations: [V1], policy: "rebuild" });
    assert.equal(userVersion(older), 1);
    assert.deepEqual(tableNames(older), ["note"]);
    older.close();
  });

  it("leaves the version untouched when a migration fails", () => {
    const path = tempPath("data.db");
    const broken: Migration = { to: 2, up: "CREATE TABLE note (this is not sql" };

    assert.throws(() => openDatabase({ path, migrations: [V1, broken], policy: "migrate" }));

    const reopened = openDatabase({ path, migrations: [V1], policy: "migrate" });
    assert.equal(userVersion(reopened), 1);
    reopened.close();
  });

  it("accepts an empty chain, which is what both files ship with today", () => {
    const db = openDatabase({ path: tempPath("cache.db"), migrations: [], policy: "rebuild" });

    assert.equal(userVersion(db), 0);
    assert.deepEqual(tableNames(db), []);

    db.close();
  });
});

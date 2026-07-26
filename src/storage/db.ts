import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { Paths } from "../config.ts";
import { CACHE_MIGRATIONS, DATA_MIGRATIONS, type Migration } from "./migrations.ts";

/**
 * One step forward. `up` is executed as-is, and `to` becomes the file's
 * `PRAGMA user_version` once it commits. ADR §10 versions both files this way,
 * which costs no metadata table.
 */
/**
 * What to do when the file disagrees with the code.
 *
 * `rebuild` is for `cache.db`: everything in it can be refetched from Pluggy,
 * so any mismatch is resolved by dropping and re-running the chain. §10 calls
 * getting this wrong "harmless" — it costs one re-sync.
 *
 * `migrate` is for `data.db`, which holds overrides, rules and closing days.
 * §10 calls getting *that* wrong not-harmless, so it moves forward or refuses.
 */
export type MigrationPolicy = "rebuild" | "migrate";

/** A `data.db` written by a newer release than the one now running. */
export class SchemaTooNewError extends Error {
  readonly found: number;
  readonly supported: number;

  constructor(path: string, found: number, supported: number) {
    super(
      `${path} is at schema version ${found}, but this version of cata-centavo only understands ${supported}. ` +
        "It was written by a newer release. Upgrade rather than downgrade — this file holds work that cannot be refetched.",
    );
    this.name = "SchemaTooNewError";
    this.found = found;
    this.supported = supported;
  }
}

export type OpenOptions = {
  readonly path: string;
  readonly migrations: readonly Migration[];
  readonly policy: MigrationPolicy;
};

export function openDatabase(options: OpenOptions): DatabaseSync {
  mkdirSync(dirname(options.path), { recursive: true });

  const db = new DatabaseSync(options.path);

  try {
    restrictToOwner(options.path);

    // WAL and a single writer, taken from the prior implementation's comment:
    // "a single local writer avoids SQLITE_BUSY" (ADR §16.1). Set before the
    // journal is created so the -wal and -shm siblings inherit the mode above.
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA foreign_keys = ON");

    migrate(db, options);
  } catch (error) {
    db.close();
    throw error;
  }

  return db;
}

export type Databases = {
  readonly cache: DatabaseSync;
  readonly data: DatabaseSync;
  close(): void;
};

/** The two files of ADR §10, opened under the policy each one earns. */
export function openDatabases(paths: Paths): Databases {
  const cache = openDatabase({ path: paths.cacheDb, migrations: CACHE_MIGRATIONS, policy: "rebuild" });

  let data: DatabaseSync;
  try {
    data = openDatabase({ path: paths.dataDb, migrations: DATA_MIGRATIONS, policy: "migrate" });
  } catch (error) {
    cache.close();
    throw error;
  }

  return {
    cache,
    data,
    close: () => {
      cache.close();
      data.close();
    },
  };
}

function migrate(db: DatabaseSync, options: OpenOptions): void {
  const target = targetVersion(options.migrations);
  const current = readUserVersion(db);

  if (current === target) {
    return;
  }

  if (options.policy === "rebuild") {
    dropEverything(db);
    apply(db, options.migrations, 0);
    return;
  }

  if (current > target) {
    throw new SchemaTooNewError(options.path, current, target);
  }

  apply(db, options.migrations, current);
}

export function targetVersion(migrations: readonly Migration[]): number {
  return migrations.reduce((highest, migration) => Math.max(highest, migration.to), 0);
}

/**
 * One transaction per step, so a chain that dies halfway leaves the file at the
 * last version that actually committed rather than at a version it never
 * reached.
 */
function apply(db: DatabaseSync, migrations: readonly Migration[], from: number): void {
  for (const migration of migrations) {
    if (migration.to <= from) {
      continue;
    }

    db.exec("BEGIN");
    try {
      db.exec(migration.up);
      stamp(db, migration.to);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}

function dropEverything(db: DatabaseSync): void {
  const objects = db.prepare("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all();

  db.exec("PRAGMA foreign_keys = OFF");
  for (const object of objects) {
    const type = String(object["type"]);
    const name = String(object["name"]).replaceAll('"', '""');

    if (type === "table") {
      db.exec(`DROP TABLE IF EXISTS "${name}"`);
    } else if (type === "view") {
      db.exec(`DROP VIEW IF EXISTS "${name}"`);
    }
  }
  db.exec("PRAGMA foreign_keys = ON");

  stamp(db, 0);
}

/** The `PRAGMA user_version` a file currently carries. */
export function schemaVersion(db: DatabaseSync): number {
  return readUserVersion(db);
}

function readUserVersion(db: DatabaseSync): number {
  const value = db.prepare("PRAGMA user_version").get()?.["user_version"];
  const version = Number(value);
  return Number.isInteger(version) ? version : 0;
}

/** `PRAGMA` takes no bound parameters, which is why the guard is here. */
function stamp(db: DatabaseSync, version: number): void {
  if (!Number.isInteger(version) || version < 0) {
    throw new Error(`refusing to stamp a non-integer schema version: ${version}`);
  }
  db.exec(`PRAGMA user_version = ${version}`);
}

/**
 * `cache.db` holds the full financial history in plaintext (ADR §9). The
 * permission bits, not the directory, are what stop a second local account
 * reading it.
 */
function restrictToOwner(path: string): void {
  if (path === ":memory:" || path === "") {
    return;
  }
  chmodSync(path, 0o600);
}

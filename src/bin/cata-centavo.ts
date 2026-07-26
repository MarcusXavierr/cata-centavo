#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { COMMANDS, resolveInvocation, type Command } from "../cli/dispatch.ts";
import { exitCodeFor, formatInit, runInit, type StorageInfo } from "../cli/init.ts";
import { loadConfig, resolvePaths } from "../config.ts";
import { createLogger } from "../logging.ts";
import { createServer } from "../mcp/server.ts";
import type { Source } from "../mcp/source.ts";
import { createPluggyClient } from "../pluggy/client.ts";
import { toFailure } from "../pluggy/errors.ts";
import { openDatabases, schemaVersion } from "../storage/db.ts";

const USAGE = `cata-centavo — Brazilian Open Finance over MCP

Usage:
  cata-centavo            MCP server over stdio (default mode)
  cata-centavo init       validates the credentials and every configured connection
  cata-centavo doctor     diagnostics: consent, connection status, last sync

Options:
  -h, --help              show this help
  -v, --version           show the version

Configuration comes from the environment:
  PLUGGY_CLIENT_ID        from your Pluggy dashboard
  PLUGGY_CLIENT_SECRET    from your Pluggy dashboard
  PLUGGY_ITEM_IDS         connection ids from MeuPluggy, separated by commas

An MCP client does not read your shell profile, so declare these in the "env"
block of its config as well.
`;

/**
 * We read package.json at runtime rather than with `import ... with { type: "json" }`.
 * An import would enter the tsc module graph and clash with "rootDir": "src".
 * With `new URL(..., import.meta.url)` the path resolves identically whether we
 * run from src/bin/ or dist/bin/ — both sit two levels below the package root.
 */
function readVersion(): string {
  const raw = readFileSync(new URL("../../package.json", import.meta.url), "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed === "object" && parsed !== null && "version" in parsed) {
    const { version } = parsed as { version: unknown };
    if (typeof version === "string") return version;
  }
  return "unknown";
}

/**
 * ADR §4: nothing but JSON-RPC may reach stdout, because in server mode stdout
 * *is* the protocol channel. All human-facing output goes to stderr.
 */
function say(message: string): void {
  if (message.endsWith("\n")) {
    process.stderr.write(message);
  } else {
    process.stderr.write(`${message}\n`);
  }
}

const systemClock = { now: () => new Date() };

/** Creates both files, runs their migrations, and lets go of the handles. */
function prepareStorage(paths: ReturnType<typeof resolvePaths>): StorageInfo {
  const databases = openDatabases(paths);

  try {
    return {
      cacheDb: paths.cacheDb,
      dataDb: paths.dataDb,
      cacheVersion: schemaVersion(databases.cache),
      dataVersion: schemaVersion(databases.data),
    };
  } finally {
    databases.close();
  }
}

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

/** Builds the source the server runs against, or the problems that block it, from a loaded config. */
function toSource(result: ReturnType<typeof loadConfig>, log: ReturnType<typeof createLogger>): Source {
  if (!result.ok) {
    return { ok: false, problems: result.problems };
  }

  return {
    ok: true,
    connections: result.config.itemIds,
    bank: createPluggyClient({
      credentials: result.config.credentials,
      clock: systemClock,
      fetch: globalThis.fetch,
      sleep,
      log,
    }),
    toFailure,
  };
}

async function run(command: Command): Promise<number> {
  if (command === COMMANDS.init) {
    const paths = resolvePaths(process.env, { platform: process.platform, home: homedir() });
    const log = createLogger({ env: process.env, logFile: paths.logFile });

    const report = await runInit({
      env: process.env,
      prepareStorage: () => prepareStorage(paths),
      createBank: (credentials) =>
        createPluggyClient({ credentials, clock: systemClock, fetch: globalThis.fetch, sleep, log }),
    });

    for (const line of formatInit(report, systemClock)) {
      say(line);
    }

    return exitCodeFor(report);
  }

  if (command === COMMANDS.serve) {
    const paths = resolvePaths(process.env, { platform: process.platform, home: homedir() });
    const log = createLogger({ env: process.env, logFile: paths.logFile });
    const result = loadConfig(process.env);
    const source = toSource(result, log);

    await createServer({ source, version: readVersion(), log }).connect(new StdioServerTransport());
    return 0;
  }

  // Phases 1 and 7 of the roadmap (ADR §15).
  say(`[stub] command "${command}" is not implemented yet`);
  return 1;
}

const invocation = resolveInvocation(process.argv.slice(2));

switch (invocation.kind) {
  case "help":
    say(USAGE);
    break;

  case "version":
    say(readVersion());
    break;

  case "error":
    say(`error: ${invocation.message}\n`);
    say(USAGE);
    process.exitCode = 2;
    break;

  case "command":
    process.exitCode = await run(invocation.command);
    break;
}

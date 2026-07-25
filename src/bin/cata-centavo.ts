#!/usr/bin/env node
import { readFileSync } from "node:fs";

import { resolveInvocation } from "../cli/dispatch.ts";

const USAGE = `cata-centavo — Brazilian Open Finance over MCP

Usage:
  cata-centavo            MCP server over stdio (default mode)
  cata-centavo init       interactive setup: validates credentials and connections
  cata-centavo doctor     diagnostics: consent, connection status, last sync

Options:
  -h, --help              show this help
  -v, --version           show the version
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
  process.stderr.write(message.endsWith("\n") ? message : `${message}\n`);
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
    // Stubs. The real implementation is Phase 0 of the roadmap (ADR §15).
    say(`[stub] command "${invocation.command}" is not implemented yet`);
    process.exitCode = 1;
    break;
}

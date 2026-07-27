import { randomUUID } from "node:crypto";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { diagnose, type ConnectionDiagnosis } from "../../core/diagnose.ts";
import { configurationProblems, finishToolError, textResult, type ToolDeps } from "./result.ts";

export const LIST_SOURCES_DESCRIPTION = `Lists every configured bank connection with its sync status and consent state.

Use this tool when:
- You want to diagnose why an account or transaction tool came back empty or unavailable.
- The user asks which banks are connected, or whether a connection needs attention.

Returns: Per connection, its institution, sync status, warnings, what the bank is waiting on, and consent state (active, revoked, expired or unknown). This lists what is configured, not what exists in your Pluggy account — a bank linked outside this configuration is invisible to it.`;

/** Registers the diagnostic tool over every configured connection. */
export function registerListSources(server: McpServer, deps: ToolDeps): void {
  server.registerTool("listSources", { description: LIST_SOURCES_DESCRIPTION }, async () => handleListSources(deps));
}

/**
 * Reports every configured connection's status and consent.
 *
 * Never returns `isError` because of connection state: a broken connection
 * *is* the diagnosis this tool exists to give, and erroring at the moment
 * everything is rotten would hide it. Only missing configuration errors.
 */
export async function handleListSources(deps: ToolDeps): Promise<CallToolResult> {
  const startedAt = Date.now();
  const log = deps.log.child({ tool: "listSources", callId: randomUUID() });
  log.info({}, "listSources started");

  if (!deps.source.ok) {
    return finishToolError(log, startedAt, configurationProblems(deps.source.problems), { problems: deps.source.problems.length });
  }

  const diagnoses = await diagnose(deps.source.bank, deps.source.connections, deps.source.toFailure, deps.clock);
  const response = { sources: diagnoses.map(formatDiagnosis) };

  log.info({ durationMs: Date.now() - startedAt, outcome: "ok", sources: diagnoses.length }, "listSources finished");

  return textResult(response);
}

function formatDiagnosis(diagnosis: ConnectionDiagnosis): unknown {
  return {
    id: diagnosis.id,
    ...formatConnectionFields(diagnosis),
    failure: diagnosis.failure,
    consent: formatConsent(diagnosis),
  };
}

function formatConnectionFields(diagnosis: ConnectionDiagnosis): Readonly<Record<string, unknown>> {
  const { connection } = diagnosis;
  if (connection === null) {
    return {};
  }

  return {
    institution: connection.institution,
    status: connection.status,
    executionStatus: connection.executionStatus,
    lastUpdatedAt: connection.lastUpdatedAt?.toISOString() ?? null,
    warnings: connection.warnings,
    parameter: connection.parameter,
    failedLogins: connection.failedLogins,
  };
}

function formatConsent(diagnosis: ConnectionDiagnosis): unknown {
  const { consent } = diagnosis;
  return {
    state: diagnosis.state,
    expiresAt: isoOrNull(consent?.expiresAt),
    revokedAt: isoOrNull(consent?.revokedAt),
    products: consent?.products ?? null,
  };
}

function isoOrNull(date: Date | null | undefined): string | null {
  if (date === null || date === undefined) {
    return null;
  }
  return date.toISOString();
}

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type { InvestmentPosition } from "../../core/investment.ts";
import {
  collectInvestments,
  compareInvestmentPositions,
  sortInvestments,
  summarizeInvestments,
  type CollectedInvestments,
} from "../../core/investments.ts";
import { toDecimal } from "../format.ts";
import { decodeCursor, encodeCursor, type InvestmentCursorFilter, type InvestmentCursorPosition } from "../investment-cursor.ts";
import { configurationProblems, finishToolError, type ToolDeps } from "./result.ts";

const getInvestmentsInput = z.object({
  connectionId: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(100).default(100),
  cursor: z.string().min(1).optional(),
});

type InvestmentsInput = z.infer<typeof getInvestmentsInput>;
type PreparedQuery =
  | {
      readonly ok: true;
      readonly selectedConnections: readonly string[];
      readonly filter: InvestmentCursorFilter;
      readonly after: InvestmentCursorPosition | undefined;
    }
  | {
      readonly ok: false;
      readonly message: string;
      readonly outcome: "invalid-connection" | "invalid-cursor";
    };
type SuccessContext = {
  readonly log: ToolDeps["log"];
  readonly startedAt: number;
  readonly input: InvestmentsInput;
  readonly query: Extract<PreparedQuery, { readonly ok: true }>;
  readonly collected: CollectedInvestments;
};


export const GET_INVESTMENTS_DESCRIPTION = `Lists active investment positions across configured bank connections, with pagination and totals grouped by currency.

Use this tool when:
- You need to inspect a portfolio's current positions, balances, quantities, or institution details.
- You need to page through more than 100 positions or restrict the result to one configured connection.

Returns: Up to 100 positions ordered by currency, balance, institution, name, and id, plus totals for the full result set. Money values are decimal strings in their original currencies; unavailable connections are reported explicitly and a cursor is returned when more positions remain.`;

export function registerGetInvestments(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "getInvestments",
    { description: GET_INVESTMENTS_DESCRIPTION, inputSchema: getInvestmentsInput },
    async (input) => handleGetInvestments(deps, input),
  );
}

export async function handleGetInvestments(deps: ToolDeps, input: unknown): Promise<CallToolResult> {
  const startedAt = Date.now();
  const parsed = getInvestmentsInput.safeParse(input);
  if (!parsed.success) {
    return finishToolError(deps.log, startedAt, validationMessage(parsed.error), { outcome: "invalid-input" });
  }

  const log = deps.log.child({ tool: "getInvestments" });
  log.info({}, "getInvestments started");
  if (!deps.source.ok) {
    return finishToolError(log, startedAt, configurationProblems(deps.source.problems), { problems: deps.source.problems.length });
  }

  const query = prepareQuery(deps.source.connections, parsed.data);
  if (!query.ok) {
    return finishToolError(log, startedAt, query.message, { outcome: query.outcome });
  }

  const collected = await collectInvestments(deps.source.bank, query.selectedConnections, deps.source.toFailure);
  if (query.selectedConnections.length > 0 && collected.unavailable.length === query.selectedConnections.length) {
    return finishToolError(log, startedAt, "All selected connections were unavailable; no investment totals could be collected.", {
      positions: 0,
      unavailable: collected.unavailable.length,
    });
  }

  return finishSuccess({ log, startedAt, input: parsed.data, query, collected });
}

function prepareQuery(connections: readonly string[], input: InvestmentsInput): PreparedQuery {
  const selectedConnections = selectConnections(connections, input.connectionId);
  if (selectedConnections === null) {
    return {
      ok: false,
      message: `Unknown connectionId: ${input.connectionId}. It is not configured.`,
      outcome: "invalid-connection",
    };
  }

  const filter: InvestmentCursorFilter = { connectionId: input.connectionId ?? null };
  const cursor = decodePosition(input.cursor, filter);
  if (cursor.error !== null) {
    return { ok: false, message: cursor.error, outcome: "invalid-cursor" };
  }

  return { ok: true, selectedConnections, filter, after: cursor.position };
}

function finishSuccess({
  log,
  startedAt,
  input,
  query,
  collected,
}: SuccessContext): CallToolResult {
  const sorted = sortInvestments(collected.positions);
  const totals = summarizeInvestments(collected.positions).map((summary) => ({
    currency: summary.currency,
    balance: toDecimal(summary.balanceCents),
  }));
  const filtered = positionsAfter(sorted, query.after);
  const page = filtered.slice(0, input.limit + 1);
  const hasMore = page.length > input.limit;
  const rows = page.slice(0, input.limit);
  const response = {
    positions: rows.map(formatPosition),
    totals,
    totalPositions: collected.positions.length,
    hasMore,
    nextCursor: nextCursorFor(rows, hasMore, query.filter),
    unavailable: collected.unavailable,
  };
  log.info({
    durationMs: Date.now() - startedAt,
    outcome: "ok",
    positions: rows.length,
    totalPositions: collected.positions.length,
    unavailable: collected.unavailable.length,
    hasMore,
  }, "getInvestments finished");
  return { content: [{ type: "text", text: JSON.stringify(response) }] };
}

function positionsAfter(
  positions: readonly InvestmentPosition[],
  after: InvestmentCursorPosition | undefined,
): readonly InvestmentPosition[] {
  if (after === undefined) {
    return positions;
  }
  return positions.filter((position) => compareInvestmentPositions(position, after) > 0);
}

function nextCursorFor(
  rows: readonly InvestmentPosition[],
  hasMore: boolean,
  filter: InvestmentCursorFilter,
): string | null {
  if (!hasMore) {
    return null;
  }
  const last = rows.at(-1);
  if (last === undefined) {
    return null;
  }
  return encodeCursor(toCursorPosition(last), filter);
}

function selectConnections(connections: readonly string[], connectionId: string | undefined): readonly string[] | null {
  if (connectionId === undefined) {
    return connections;
  }
  if (connections.includes(connectionId)) {
    return [connectionId];
  }
  return null;
}

function decodePosition(cursor: string | undefined, filter: InvestmentCursorFilter): {
  readonly position: InvestmentCursorPosition | undefined;
  readonly error: string | null;
} {
  if (cursor === undefined) {
    return { position: undefined, error: null };
  }
  const decoded = decodeCursor(cursor, filter);
  if (!decoded.ok) {
    return { position: undefined, error: `Invalid investment cursor: ${decoded.message}.` };
  }
  return { position: decoded.position, error: null };
}

function toCursorPosition(position: InvestmentPosition): InvestmentCursorPosition {
  return {
    currency: position.currency,
    balanceCents: position.balanceCents,
    institution: position.institution,
    name: position.name,
    id: position.id,
  };
}

function formatPosition(position: InvestmentPosition): Record<string, unknown> {
  const formatted: Record<string, unknown> = {
    id: position.id,
    connectionId: position.connectionId,
    institution: position.institution,
    name: position.name,
    type: position.type,
    subtype: position.subtype,
    balance: toDecimal(position.balanceCents),
    currency: position.currency,
  };
  if (position.quantity !== null) {
    formatted.quantity = position.quantity;
  }
  return formatted;
}

function validationMessage(error: z.ZodError): string {
  return `Invalid investments input: ${error.issues.map((issue) => `${issue.path.join(".") || "input"} ${issue.message}`).join("; ")}.`;
}

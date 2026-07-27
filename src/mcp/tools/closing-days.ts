import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type { ClosingDayStore } from "../../core/contracts.ts";
import { configurationProblems, finishToolError, textResult, type ToolDeps } from "./result.ts";

export const LIST_CLOSING_DAYS_DESCRIPTION = `Lists the closing days stored locally for credit cards.

Use this tool when:
- You need to see which cards have a manual closing-day fallback.
- You need the stored day before changing or deleting it.

Returns: Every stored account id and closing day. An empty list means no closing days are stored.`;

export const SET_CLOSING_DAY_DESCRIPTION = `Stores the billing-cycle closing day for one credit card.

Use this tool when:
- The bank does not report the card's closing day.
- The user wants to correct an existing stored day.

Returns: The account id and day that were stored. This replaces any earlier day for the card.`;

export const DELETE_CLOSING_DAY_DESCRIPTION = `Deletes the closing day stored locally for one credit card.

Use this tool when:
- A stored closing day is wrong and should no longer be used.
- The bank now reports the closing day and the manual fallback is no longer needed.

Returns: The account id and the number of stored rows deleted.`;

const accountIdSchema = z.string().min(1);

const setClosingDaySchema = z.object({
  accountId: accountIdSchema,
  day: z.number().int().min(1).max(31),
});

const deleteClosingDaySchema = z.object({
  accountId: accountIdSchema,
});

export function registerListClosingDays(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "listClosingDays",
    { description: LIST_CLOSING_DAYS_DESCRIPTION },
    async () => handleListClosingDays(deps),
  );
}

export function registerSetClosingDay(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "setClosingDay",
    { description: SET_CLOSING_DAY_DESCRIPTION, inputSchema: setClosingDaySchema },
    async (input) => handleSetClosingDay(deps, input),
  );
}

export function registerDeleteClosingDay(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "deleteClosingDay",
    { description: DELETE_CLOSING_DAY_DESCRIPTION, inputSchema: deleteClosingDaySchema },
    async (input) => handleDeleteClosingDay(deps, input),
  );
}

export async function handleListClosingDays(deps: ToolDeps): Promise<CallToolResult> {
  const startedAt = Date.now();
  const resolved = resolveStore(deps, startedAt, "listClosingDays");
  if (!resolved.ok) {
    return resolved.result;
  }

  return textResult({ closingDays: resolved.store.list() });
}

export async function handleSetClosingDay(deps: ToolDeps, rawInput: unknown): Promise<CallToolResult> {
  const startedAt = Date.now();
  const parsed = setClosingDaySchema.safeParse(rawInput);
  if (!parsed.success) {
    return finishToolError(deps.log, startedAt, parsed.error.message, { tool: "setClosingDay" });
  }

  const resolved = resolveStore(deps, startedAt, "setClosingDay");
  if (!resolved.ok) {
    return resolved.result;
  }

  resolved.store.set(parsed.data.accountId, parsed.data.day);
  return textResult(parsed.data);
}

export async function handleDeleteClosingDay(deps: ToolDeps, rawInput: unknown): Promise<CallToolResult> {
  const startedAt = Date.now();
  const parsed = deleteClosingDaySchema.safeParse(rawInput);
  if (!parsed.success) {
    return finishToolError(deps.log, startedAt, parsed.error.message, { tool: "deleteClosingDay" });
  }

  const resolved = resolveStore(deps, startedAt, "deleteClosingDay");
  if (!resolved.ok) {
    return resolved.result;
  }

  const deleted = resolved.store.delete(parsed.data.accountId);
  return textResult({ accountId: parsed.data.accountId, deleted });
}

type StoreResolution =
  | { readonly ok: true; readonly store: ClosingDayStore }
  | { readonly ok: false; readonly result: CallToolResult };

function resolveStore(deps: ToolDeps, startedAt: number, tool: string): StoreResolution {
  if (!deps.source.ok) {
    return {
      ok: false,
      result: finishToolError(deps.log, startedAt, configurationProblems(deps.source.problems), { tool }),
    };
  }
  if (deps.closingDays === null || deps.closingDays === undefined) {
    return {
      ok: false,
      result: finishToolError(deps.log, startedAt, "Closing-day storage is unavailable.", { tool }),
    };
  }
  return { ok: true, store: deps.closingDays };
}

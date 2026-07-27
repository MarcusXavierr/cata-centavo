import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { isCategoryId } from "../../core/category.ts";
import { isDocument } from "../../core/counterparty.ts";
import { configurationProblems, finishToolError, textResult, type ToolDeps } from "./result.ts";

export const SET_CATEGORY_DESCRIPTION = `Corrects the category of specific transactions.

Use this tool when:
- The user tells you a transaction is in the wrong category.
- You listed uncategorized transactions with categories: ["none"] and the user said what they are.

Returns: How many transactions were corrected, and any ids that are not in the local cache.`;

export const SET_COUNTERPARTY_CATEGORY_DESCRIPTION = `Assigns a category to everyone a CPF or CNPJ identifies, backwards and forwards.

Use this tool when:
- The user tells you what a merchant is, rather than what one transaction is.
- The same counterparty keeps landing in the wrong category.

Returns: The document, the category, and how many cached transactions now resolve through it. That count is the blast radius — read it back to the user when it is larger than they expected.`;

const categoryInput = z.string().refine(isCategoryId, "must be a known category id");

export const setCategorySchema = z.object({
  transactionIds: z.array(z.string().min(1)).min(1).max(100),
  category: categoryInput,
});

export const setCounterpartyCategorySchema = z.object({
  document: z.string().min(1),
  category: categoryInput,
});

export function registerSetCategory(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "setCategory",
    { description: SET_CATEGORY_DESCRIPTION, inputSchema: setCategorySchema },
    async (input) => handleSetCategory(deps, input),
  );
}

export function registerSetCounterpartyCategory(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "setCounterpartyCategory",
    { description: SET_COUNTERPARTY_CATEGORY_DESCRIPTION, inputSchema: setCounterpartyCategorySchema },
    async (input) => handleSetCounterpartyCategory(deps, input),
  );
}

export async function handleSetCategory(deps: ToolDeps, rawInput: unknown): Promise<CallToolResult> {

  const startedAt = Date.now();
  if (!deps.source.ok) {
    return finishToolError(deps.log, startedAt, configurationProblems(deps.source.problems), { tool: "setCategory" });
  }

  const parsed = setCategorySchema.safeParse(rawInput);
  if (!parsed.success) {
    return finishToolError(deps.log, startedAt, parsed.error.message, { tool: "setCategory" });
  }

  const writer = deps.writer ?? deps.source.writer;
  if (!writer) {
    return finishToolError(deps.log, startedAt, "Storage is read-only", { tool: "setCategory" });
  }

  const result = writer.setCategory(parsed.data.transactionIds, parsed.data.category);
  return textResult(result);
}

export async function handleSetCounterpartyCategory(deps: ToolDeps, rawInput: unknown): Promise<CallToolResult> {
  const startedAt = Date.now();
  if (!deps.source.ok) {
    return finishToolError(deps.log, startedAt, configurationProblems(deps.source.problems), { tool: "setCounterpartyCategory" });
  }

  const parsed = setCounterpartyCategorySchema.safeParse(rawInput);
  if (!parsed.success) {
    return finishToolError(deps.log, startedAt, parsed.error.message, { tool: "setCounterpartyCategory" });
  }

  const cleanDoc = parsed.data.document.replace(/\D/g, "");
  if (!isDocument(cleanDoc)) {
    return finishToolError(deps.log, startedAt, "document must be an 11-digit CPF or 14-digit CNPJ", { tool: "setCounterpartyCategory" });
  }

  const writer = deps.writer ?? deps.source.writer;
  if (!writer) {
    return finishToolError(deps.log, startedAt, "Storage is read-only", { tool: "setCounterpartyCategory" });
  }

  const result = writer.setCounterpartyCategory(cleanDoc, parsed.data.category);
  return textResult({
    document: cleanDoc,
    category: parsed.data.category,
    affected: result.affected,
  });
}

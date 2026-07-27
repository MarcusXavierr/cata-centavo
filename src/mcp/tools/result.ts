import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { CategoryWriter, Clock, Logger } from "../../core/contracts.ts";

import type { TransactionReader } from "../../core/transactions.ts";
import { prune } from "../format.ts";
import type { Source } from "../source.ts";

export type ToolDeps = {
  readonly source: Source;
  readonly log: Logger;
  readonly reader: TransactionReader | null;
  readonly writer: CategoryWriter | null;
  readonly clock: Clock;
};


export function finishToolError(
  log: Logger,
  startedAt: number,
  message: string,
  fields: Readonly<Record<string, unknown>>,
): CallToolResult {
  log.info({ durationMs: Date.now() - startedAt, outcome: "tool-error", ...fields }, "Tool finished with an error");

  return { content: [{ type: "text", text: message }], isError: true };
}

export function configurationProblems(problems: readonly string[]): string {
  return `Configuration problems:\n${problems.join("\n")}`;
}

export function textResult(payload: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(prune(payload)) }] };
}

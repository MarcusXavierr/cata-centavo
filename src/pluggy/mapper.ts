import type { Connection } from "../core/contracts.ts";
import type { WireItem } from "./wire.ts";

/**
 * Where Pluggy's vocabulary stops and ours begins (ADR §14.0). An *item* is a
 * connection, and no domain type past this file mentions the other word.
 *
 * This is also the only place that knows dates arrive as strings, since we
 * parse the raw body rather than going through the SDK's date reviver.
 */
export function toConnection(item: WireItem): Connection {
  return {
    id: item.id,
    institution: item.connector.name,
    status: item.status,
    executionStatus: item.executionStatus ?? null,
    lastUpdatedAt: item.lastUpdatedAt === null ? null : new Date(item.lastUpdatedAt),
    parameter: item.parameter?.label ?? null,
    warnings: toWarnings(item.statusDetail),
  };
}

/**
 * `statusDetail` is keyed by product, and a `PARTIAL_SUCCESS` puts the reason one
 * product went unrefreshed in its `warnings`. Flattened with the product name in
 * front, because "credit card bills hit their monthly quota" is the useful
 * sentence and "the monthly quota was reached" on its own is not.
 */
function toWarnings(statusDetail: WireItem["statusDetail"]): readonly string[] {
  if (statusDetail === null || statusDetail === undefined) {
    return [];
  }

  return Object.entries(statusDetail).flatMap(([product, detail]) =>
    (detail?.warnings ?? []).map((warning) => `${product}: ${warning.message}`),
  );
}

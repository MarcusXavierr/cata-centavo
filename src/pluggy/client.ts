import type { z } from "zod";

import type { Bank, Connection, RefreshStart } from "../core/contracts.ts";
import { classify, failureFor, parse, readErrorDetail, readJson } from "./errors.ts";
import { toConnection } from "./mapper.ts";
import { createTransport, type TransportOptions } from "./transport.ts";
import { ITEM, refusesManualUpdate, UPDATE_REFUSED } from "./wire.ts";

export type PluggyClientOptions = TransportOptions;

/**
 * The Pluggy client, written rather than taken from `pluggy-sdk`.
 *
 * The SDK resolves the key lazily and checks the JWT already, so the ADR's
 * original complaint does not apply to it. What it has no way to offer is a
 * margin, a single-flight, a 401 retry or a rate limiter, because the key cache
 * is private instance state and the send function is not ours. ADR §15 Phase 0
 * records the whole comparison. All four live in `transport.ts`; what is left
 * here is the vocabulary of connections.
 *
 * Construction performs no I/O (§16.2).
 */
export function createPluggyClient(options: PluggyClientOptions): Bank {
  const transport = createTransport(options);

  async function get<T>(path: string, schema: z.ZodType<T>, describe: string): Promise<T> {
    const response = await transport.authorized("GET", path);

    if (!response.ok) {
      throw await failureFor(response, describe);
    }

    return parse(schema, await readJson(response), describe);
  }

  return {
    verifyCredentials: async () => {
      await transport.key();
    },

    getConnection: async (id: string): Promise<Connection> => {
      const item = await get(`/items/${encodeURIComponent(id)}`, ITEM, `connection ${id}`);
      return toConnection(item);
    },

    refreshConnection: async (id: string): Promise<RefreshStart> => {
      const path = `/items/${encodeURIComponent(id)}`;
      const response = await transport.authorized("PATCH", path, {});

      if (response.status === 409) {
        return refusal(await readRefusal(response));
      }

      if (!response.ok) {
        // The body is readable once, so the detail is read before it is judged:
        // a 400 saying the connector has no on-demand update is an answer, and
        // every other 400 keeps that same detail in its message.
        const detail = await readErrorDetail(response);

        if (response.status === 400 && refusesManualUpdate(detail)) {
          return { kind: "not-refreshable" };
        }

        throw classify(response.status, `refreshing connection ${id}`, detail);
      }

      const item = parse(ITEM, await readJson(response), `connection ${id}`);
      return { kind: "started", connection: toConnection(item) };
    },
  };
}

/**
 * A 409 means the last sync is too recent, which is the debounce of ADR §11 and
 * an answer rather than a failure. A body we cannot read is still that answer, so
 * nothing here throws.
 */
async function readRefusal(response: Response): Promise<z.infer<typeof UPDATE_REFUSED> | null> {
  try {
    const parsed = UPDATE_REFUSED.safeParse(await response.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function refusal(body: z.infer<typeof UPDATE_REFUSED> | null): RefreshStart {
  const data = body?.data;

  return {
    kind: "too-soon",
    everyHours: data?.minUpdateFrequencyAllowedInHours ?? null,
    lastUpdatedAt: toDate(data?.lastUpdatedAt),
  };
}

/** Pluggy both omits the field and sends it null; either way we were not told. */
function toDate(value: string | null | undefined): Date | null {
  return value === null || value === undefined ? null : new Date(value);
}

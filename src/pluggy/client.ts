import type { z } from "zod";

import type { Bank, Connection } from "../core/contracts.ts";
import { failureFor, parse, readJson } from "./errors.ts";
import { toConnection } from "./mapper.ts";
import { createTransport, type TransportOptions } from "./transport.ts";
import { ITEM } from "./wire.ts";

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
  };
}

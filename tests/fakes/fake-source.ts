import type { Source } from "../../src/mcp/source.ts";
import { toFailure } from "../../src/pluggy/errors.ts";
import { fakeBank, threeConnections } from "./fake-bank.ts";
import type { FakeBank, FakeBankOptions } from "./fake-bank.ts";

export type FakeSourceOptions = Pick<FakeBankOptions, "accounts" | "connections" | "unreachable">;

export type FakeSource = Extract<Source, { readonly ok: true }> & {
  readonly bank: FakeBank;
};

/** A ready MCP source backed by the standard three-connection bank fixture. */
export function fakeSource(options: FakeSourceOptions = {}): FakeSource {
  const defaults = threeConnections();
  const connections = options.connections ?? defaults.connections;
  const accounts = options.accounts ?? defaults.accounts;

  let unreachableField: Pick<FakeBankOptions, "unreachable">;
  if (options.unreachable === undefined) {
    unreachableField = {};
  } else {
    unreachableField = { unreachable: options.unreachable };
  }

  return {
    ok: true,
    connections: connections.map(({ id }) => id),
    bank: fakeBank({
      connections,
      accounts,
      ...unreachableField,
    }),
    toFailure,
  };
}

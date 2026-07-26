import type { Source } from "../../src/mcp/source.ts";
import { createTransactionReader } from "../../src/core/transactions.ts";
import { openDatabase } from "../../src/storage/db.ts";
import { CACHE_MIGRATIONS } from "../../src/storage/migrations.ts";
import { createTransactionStore } from "../../src/storage/transactions.ts";
import { toFailure } from "../../src/pluggy/errors.ts";
import { fakeBank, threeConnections } from "./fake-bank.ts";
import type { FakeBank, FakeBankOptions } from "./fake-bank.ts";
import { fakeLogger } from "./fake-logger.ts";

export type FakeSourceOptions = Pick<FakeBankOptions, "accounts" | "connections" | "unreachable" | "transactions" | "categories">;

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

  let transactionFields: Pick<FakeBankOptions, "transactions" | "categories"> = {};
  if (options.transactions !== undefined) {
    transactionFields = { ...transactionFields, transactions: options.transactions };
  }
  if (options.categories !== undefined) {
    transactionFields = { ...transactionFields, categories: options.categories };
  }

  const bank = fakeBank({
    connections,
    accounts,
    ...unreachableField,
    ...transactionFields,
  });
  const store = createTransactionStore(openDatabase({ path: ":memory:", migrations: CACHE_MIGRATIONS, policy: "rebuild" }));
  const reader = createTransactionReader({ bank, store, toFailure, log: fakeLogger() });

  return {
    ok: true,
    connections: connections.map(({ id }) => id),
    bank,
    toFailure,
    reader,
  };
}

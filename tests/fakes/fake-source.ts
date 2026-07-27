import type { Source } from "../../src/mcp/source.ts";
import { createTransactionReader } from "../../src/core/transactions.ts";
import { openDatabase } from "../../src/storage/db.ts";
import { CACHE_MIGRATIONS } from "../../src/storage/migrations.ts";
import { createTransactionStore } from "../../src/storage/transactions.ts";
import { toFailure } from "../../src/pluggy/errors.ts";
import { fakeBank, threeConnections } from "./fake-bank.ts";
import type { FakeBank, FakeBankOptions } from "./fake-bank.ts";
import { fakeLogger } from "./fake-logger.ts";

import type { CategoryWriter } from "../../src/core/contracts.ts";

export type FakeSourceOptions = Pick<
  FakeBankOptions,
  "accounts" | "connections" | "unreachable" | "transactions" | "bills" | "consents" | "unreachableConsent"
>;

export type FakeSource = Extract<Source, { readonly ok: true }> & {
  readonly bank: FakeBank;
};

const dummyWriter: CategoryWriter = {
  setCategory: () => ({ updated: 0, unknownIds: [] }),
  setCounterpartyCategory: () => ({ affected: 0 }),
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

  let transactionFields: Pick<FakeBankOptions, "transactions"> = {};
  if (options.transactions !== undefined) {
    transactionFields = { ...transactionFields, transactions: options.transactions };
  }

  let billFields: Pick<FakeBankOptions, "bills"> = {};
  if (options.bills !== undefined) {
    billFields = { ...billFields, bills: options.bills };
  }

  let consentFields: Pick<FakeBankOptions, "consents"> = {};
  if (options.consents !== undefined) {
    consentFields = { ...consentFields, consents: options.consents };
  }

  let unreachableConsentFields: Pick<FakeBankOptions, "unreachableConsent"> = {};
  if (options.unreachableConsent !== undefined) {
    unreachableConsentFields = { ...unreachableConsentFields, unreachableConsent: options.unreachableConsent };
  }

  const bank = fakeBank({
    connections,
    accounts,
    ...unreachableField,
    ...transactionFields,
    ...billFields,
    ...consentFields,
    ...unreachableConsentFields,
  });
  const store = createTransactionStore(
    openDatabase({ path: ":memory:", migrations: CACHE_MIGRATIONS, policy: "rebuild" }),
    fakeLogger(),
  );

  const reader = createTransactionReader({ bank, store, toFailure, log: fakeLogger(), clock: { now: () => new Date() } });

  return {
    ok: true,
    connections: connections.map(({ id }) => id),
    bank,
    toFailure,
    reader,
    writer: dummyWriter,
  };
}

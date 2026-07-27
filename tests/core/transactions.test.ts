import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createTransactionReader, type TransactionReader } from "../../src/core/transactions.ts";
import type { TransactionFilter, TransactionStore } from "../../src/core/contracts.ts";
import { openDatabase } from "../../src/storage/db.ts";
import { CACHE_MIGRATIONS } from "../../src/storage/migrations.ts";
import { createTransactionStore } from "../../src/storage/transactions.ts";
import { toFailure, AuthError } from "../../src/pluggy/errors.ts";
import { account, connection, fakeBank, type FakeBank, type FakeBankOptions } from "../fakes/fake-bank.ts";
import { fakeLogger } from "../fakes/fake-logger.ts";
import { tx } from "../fakes/transaction-builder.ts";

const WIDE_FILTER: TransactionFilter = { accountIds: ["acc-1"], from: "2000-01-01", to: "2100-01-01" };
const INITIAL_UPDATE = "2026-07-26T12:00:00.000Z";

type ReaderOptions = {
  readonly transactions?: Readonly<Record<string, readonly ReturnType<typeof tx>[]>>;
  readonly lastUpdatedAt?: string | null;
  readonly unreachable?: Readonly<Record<string, Error>>;
  readonly walkFails?: boolean;
};

type ReaderFixture = {
  readonly reader: TransactionReader;
  readonly bank: FakeBank;
  readonly store: TransactionStore;
  readonly setLastUpdatedAt: (connectionId: string, value: string | null) => void;
  readonly recover: () => void;
};

function readerFor(options: ReaderOptions = {}): ReaderFixture {
  let stamp: string | null = INITIAL_UPDATE;
  if (options.lastUpdatedAt !== undefined) {
    stamp = options.lastUpdatedAt;
  }
  const firstConnection = connection("conn-1", { lastUpdatedAt: dateOrNull(stamp) });
  const secondConnection = connection("conn-2", { lastUpdatedAt: dateOrNull(stamp) });
  const firstAccount = account("acc-1", { connectionId: "conn-1", lastUpdatedAt: dateOrNull(stamp) });
  const secondAccount = account("acc-2", { connectionId: "conn-2", lastUpdatedAt: dateOrNull(stamp) });
  const accounts: Record<string, readonly typeof firstAccount[]> = { "conn-1": [firstAccount], "conn-2": [secondAccount] };
  const transactions = options.transactions ?? { "acc-1": [tx({ id: "default" })] };
  let bankOptions: FakeBankOptions = {
    connections: [firstConnection, secondConnection],
    accounts,
    transactions,
  };
  if (options.unreachable !== undefined) {
    bankOptions = { ...bankOptions, unreachable: options.unreachable };
  }
  const bank = fakeBank(bankOptions);
  const store = createTransactionStore(
    openDatabase({ path: ":memory:", migrations: CACHE_MIGRATIONS, policy: "rebuild" }),
    fakeLogger(),
  );
  let walkFails = options.walkFails === true;


  if (options.walkFails === true) {
    const originalGetTransactions = bank.getTransactions;
    const calls = bank.calls as string[];
    bank.getTransactions = async (candidate) => {
      if (walkFails) {
        calls.push(`transactions:${candidate.id}`);
        throw new Error("walk failed");
      }
      return originalGetTransactions(candidate);
    };
  }

  const reader = createTransactionReader({ bank, store, toFailure, log: fakeLogger() });
  const setLastUpdatedAt = (connectionId: string, value: string | null): void => {
    const matchingConnection = [firstConnection, secondConnection].find(({ id }) => id === connectionId);
    const matchingAccounts = accounts[connectionId] ?? [];
    if (matchingConnection === undefined) {
      throw new Error(`unknown connection ${connectionId}`);
    }
    Object.assign(matchingConnection, { lastUpdatedAt: dateOrNull(value) });
    for (const candidate of matchingAccounts) {
      Object.assign(candidate, { lastUpdatedAt: dateOrNull(value) });
    }
  };

  return { reader, bank, store, setLastUpdatedAt, recover: () => { walkFails = false; } };
}

function dateOrNull(value: string | null): Date | null {
  if (value === null) {
    return null;
  }
  return new Date(value);
}

function walkCount(bank: FakeBank): number {
  return bank.calls.filter((call) => call.startsWith("transactions:")).length;
}

describe("createTransactionReader", () => {
  it("walks and stores on a cold cache", async () => {
    const { reader, store } = readerFor({ transactions: { "acc-1": [tx({ id: "a" })] } });

    await reader.load(["conn-1"]);

    assert.equal(store.query(WIDE_FILTER).length, 1);
  });

  it("does not re-walk when the update time is unchanged", async () => {
    const { reader, bank } = readerFor({ lastUpdatedAt: INITIAL_UPDATE });
    await reader.load(["conn-1"]);

    await reader.load(["conn-1"]);

    assert.equal(walkCount(bank), 1);
  });

  it("re-walks in full when the update time is newer", async () => {
    const { reader, bank, setLastUpdatedAt } = readerFor({ lastUpdatedAt: INITIAL_UPDATE });
    await reader.load(["conn-1"]);

    setLastUpdatedAt("conn-1", "2026-07-27T12:00:00.000Z");
    await reader.load(["conn-1"]);

    assert.equal(walkCount(bank), 2);
  });

  it("always re-walks when the update time is unknown", async () => {
    const { reader, bank } = readerFor({ lastUpdatedAt: null });
    await reader.load(["conn-1"]);
    await reader.load(["conn-1"]);

    assert.equal(walkCount(bank), 2);
  });

  it("does not fetch the connection separately from its accounts", async () => {
    const { reader, bank } = readerFor({ lastUpdatedAt: INITIAL_UPDATE });
    await reader.load(["conn-1"]);
    const warm = bank.calls.length;

    await reader.load(["conn-1"]);

    assert.equal(bank.calls.length - warm, 1);
  });

  it("walks an account once when two loads arrive together", async () => {
    const { reader, bank } = readerFor({ lastUpdatedAt: INITIAL_UPDATE });

    const [first, second] = await Promise.all([reader.load(["conn-1"]), reader.load(["conn-1"])]);

    assert.equal(walkCount(bank), 1);
    assert.deepEqual(first, second);
  });

  it("does not leave a failed walk in flight", async () => {
    const { reader, bank, recover } = readerFor({ walkFails: true });
    await assert.rejects(() => reader.load(["conn-1"]));

    recover();
    await reader.load(["conn-1"]);

    assert.equal(walkCount(bank), 2);
  });

  it("does not stamp freshness when the walk fails", async () => {
    const { reader, store } = readerFor({ walkFails: true });

    await assert.rejects(() => reader.load(["conn-1"]));

    assert.equal(store.syncedLastUpdatedAt("acc-1"), undefined);
  });

  it("reports an unavailable connection rather than throwing", async () => {
    const { reader } = readerFor({ unreachable: { "conn-2": new AuthError("revoked", 401) } });

    const result = await reader.load(["conn-1", "conn-2"]);

    assert.equal(result.unavailable.length, 1);
    assert.equal(result.unavailable[0]?.connectionId, "conn-2");
  });

  it("walks the accounts of a healthy connection when another is unavailable", async () => {
    const { reader, store } = readerFor({ unreachable: { "conn-2": new AuthError("revoked", 401) } });

    await reader.load(["conn-1", "conn-2"]);

    assert.ok(store.query(WIDE_FILTER).length > 0);
  });
});

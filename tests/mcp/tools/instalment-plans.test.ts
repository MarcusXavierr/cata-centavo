import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { Account } from "../../../src/core/account.ts";
import type { ClosingDayStore } from "../../../src/core/contracts.ts";
import type { DerivedTransaction } from "../../../src/core/transaction.ts";
import type { LoadResult, TransactionReader } from "../../../src/core/transactions.ts";
import type { ToolDeps } from "../../../src/mcp/tools/result.ts";
import { handleListInstalmentPlans } from "../../../src/mcp/tools/instalment-plans.ts";
import { bill } from "../../fakes/bill-builder.ts";
import { account, connection } from "../../fakes/fake-bank.ts";
import { fakeLogger } from "../../fakes/fake-logger.ts";
import { fakeSource, type FakeSource } from "../../fakes/fake-source.ts";
import { fixedClock } from "../../fakes/fixed-clock.ts";
import { derived } from "../../fakes/transaction-builder.ts";

function message(result: CallToolResult): string {
  const first = result.content[0];
  assert.ok(first !== undefined && first.type === "text");
  return first.text;
}

type PlanPayload = {
  readonly plans: readonly Record<string, unknown>[];
  readonly totals?: { readonly planCount: number; readonly remaining: string };
  readonly notes?: readonly string[];
  readonly dataThrough?: readonly { readonly connectionId: string; readonly through: string }[];
  readonly unavailable?: readonly { readonly connectionId: string; readonly kind: string; readonly message: string }[];
  readonly notice?: string;
};

function payload(result: CallToolResult): PlanPayload {
  return JSON.parse(message(result)) as PlanPayload;
}


type ReaderFixture = {
  readonly reader: TransactionReader;
  readonly loadCalls: string[][];
  readonly rowCalls: string[];
};
function readerFixture(
  accounts: readonly Account[],
  rowsByAccount: Readonly<Record<string, readonly DerivedTransaction[]>>,
  unavailable: LoadResult["unavailable"] = [],
  dataThrough: ReadonlyMap<string, string> = new Map(),
): ReaderFixture {
  const loadCalls: string[][] = [];
  const rowCalls: string[] = [];
  return {
    loadCalls,
    rowCalls,
    reader: {
      load: async (connectionIds) => {
        loadCalls.push([...connectionIds]);
        return {
          accounts: accounts.filter((candidate) => connectionIds.includes(candidate.connectionId)),
          unavailable,
        };
      },
      query: () => [],
      byIds: () => [],
      cardRows: (accountId) => {
        rowCalls.push(accountId);
        return rowsByAccount[accountId] ?? [];
      },
      dataThrough: () => dataThrough,
    },
  };
}

function closingDays(entries: readonly { readonly accountId: string; readonly day: number }[]): ClosingDayStore {
  return { list: () => entries, set: () => undefined, delete: () => 0 };
}

function depsWith(source: FakeSource, reader: TransactionReader, closingDayStore: ClosingDayStore = closingDays([])): ToolDeps {
  return {
    source,
    reader,
    writer: source.writer,
    log: fakeLogger(),
    closingDays: closingDayStore,
    clock: fixedClock(new Date("2026-07-30T12:00:00.000Z")),
  };
}

function cardRows(accountId: string, connectionId: string, prefix: string, billId: string | null = null): readonly DerivedTransaction[] {
  let purchaseDate = "2026-04-08T12:00:00.000Z";
  if (prefix === "SETTLED") {
    purchaseDate = "2026-04-09T12:00:00.000Z";
  }
  return [1, 2].map((number) => derived({
    id: `${prefix}-${number}`,
    accountId,
    connectionId,
    accountType: "CREDIT",
    accountSubtype: "CREDIT_CARD",
    localDate: `2026-0${number + 4}-08`,
    amountCents: -1_000,
    description: prefix,
    descriptionNorm: prefix,
    billId,
    billForecastDate: null,
    instalmentNumber: number,
    instalmentTotal: 2,
    purchaseDate,
  }));
}

function setup(): {
  readonly source: FakeSource;
  readonly reader: ReaderFixture;
  readonly cards: readonly Account[];
} {
  const cardA = account("card-a", {
    connectionId: "conn-a",
    type: "CREDIT",
    subtype: "CREDIT_CARD",
    credit: { limitCents: 100_000, availableLimitCents: 90_000, balanceCloseDate: null, balanceDueDate: new Date("2026-07-15T03:00:00.000Z"), brand: "Synthetic" },
  });
  const cardB = account("card-b", {
    connectionId: "conn-b",
    type: "CREDIT",
    subtype: "CREDIT_CARD",
    credit: { limitCents: 100_000, availableLimitCents: 90_000, balanceCloseDate: null, balanceDueDate: new Date("2026-07-15T03:00:00.000Z"), brand: "Synthetic" },
  });
  const bankAccount = account("bank-a", { connectionId: "conn-a" });
  const cards = [cardA, cardB];
  const source = fakeSource({
    connections: [connection("conn-a"), connection("conn-b")],
    accounts: { "conn-a": [cardA, bankAccount], "conn-b": [cardB] },
    bills: { "card-a": [bill({ id: "closed-a", closingDate: "2026-07-08", dueDate: "2026-07-15" })], "card-b": [] },
  });
  const rows = {
    "card-a": [...cardRows("card-a", "conn-a", "OPEN"), ...cardRows("card-a", "conn-a", "SETTLED", "closed-a")],
    "card-b": cardRows("card-b", "conn-b", "OTHER"),
  };
  return { source, reader: readerFixture([...cards, bankAccount], rows), cards };
}

const FILTER_CASES = [
  { name: "no filter returns every card", input: {}, expectedAccountIds: ["card-a", "card-b"], expectedLoad: ["conn-a", "conn-b"] },
  { name: "accountId restricts to one card", input: { accountId: "card-b" }, expectedAccountIds: ["card-b"], expectedLoad: ["conn-a", "conn-b"] },
  { name: "connectionId restricts to one connection", input: { connectionId: "conn-b" }, expectedAccountIds: ["card-b"], expectedLoad: ["conn-b"] },
] as const;
describe("listInstalmentPlans filters", () => {
  for (const testCase of FILTER_CASES) {
    it(testCase.name, async () => {
      const fixture = setup();
      const result = await handleListInstalmentPlans(depsWith(fixture.source, fixture.reader.reader), testCase.input);
      const plans = payload(result).plans as readonly { readonly accountId: string }[];

      assert.deepEqual(plans.map(({ accountId }) => accountId), testCase.expectedAccountIds);
      assert.deepEqual(fixture.reader.loadCalls, [testCase.expectedLoad]);
    });
  }

  it("returns a readable notice for an unknown connection", async () => {
    const fixture = setup();
    const result = await handleListInstalmentPlans(depsWith(fixture.source, fixture.reader.reader), { connectionId: "missing-connection" });

    assert.notEqual(result.isError, true);
    assert.match(message(result), /missing-connection/);
    assert.deepEqual(payload(result).plans, []);
    assert.deepEqual(fixture.reader.loadCalls, [[]]);
  });

  it("returns a tool error when accountId resolves to a non-credit account", async () => {
    const fixture = setup();
    const result = await handleListInstalmentPlans(depsWith(fixture.source, fixture.reader.reader), { accountId: "bank-a" });

    assert.equal(result.isError, true);
    assert.match(message(result), /BANK.*CREDIT/u);
  });
});

describe("listInstalmentPlans includeSettled", () => {
  it("omits settled plans by default and includes them when requested", async () => {
    const fixture = setup();
    const defaultResult = await handleListInstalmentPlans(depsWith(fixture.source, fixture.reader.reader), {});
    const settledResult = await handleListInstalmentPlans(depsWith(fixture.source, fixture.reader.reader), { includeSettled: true });

    assert.deepEqual(
      payload(defaultResult).plans.map(({ accountId, status }) => ({ accountId, status })),
      [{ accountId: "card-a", status: "open" }, { accountId: "card-b", status: "open" }],
    );
    assert.deepEqual(
      payload(settledResult).plans
        .map(({ accountId, status }) => ({ accountId, status }))
        .sort((left, right) => `${left.accountId}:${left.status}`.localeCompare(`${right.accountId}:${right.status}`)),
      [{ accountId: "card-a", status: "open" }, { accountId: "card-a", status: "settled" }, { accountId: "card-b", status: "open" }],
    );
  });
});
 
describe("listInstalmentPlans serialization and totals", () => {
  it("serializes money as decimal strings and carries card identity and freshness", async () => {
    const fixture = setup();
    const rows = [
      derived({
        id: "decimal-1",
        accountId: "card-a",
        connectionId: "conn-a",
        accountType: "CREDIT",
        accountSubtype: "CREDIT_CARD",
        localDate: "2026-06-08",
        amountCents: -1_001,
        description: "DECIMAL",
        descriptionNorm: "DECIMAL",
        billId: "closed-a",
        instalmentNumber: 1,
        instalmentTotal: 2,
        purchaseDate: "2026-05-28T12:00:00.000Z",
      }),
      derived({
        id: "decimal-2",
        accountId: "card-a",
        connectionId: "conn-a",
        accountType: "CREDIT",
        accountSubtype: "CREDIT_CARD",
        localDate: "2026-07-08",
        amountCents: -999,
        description: "DECIMAL",
        descriptionNorm: "DECIMAL",
        billId: null,
        instalmentNumber: 2,
        instalmentTotal: 2,
        purchaseDate: "2026-05-28T12:00:00.000Z",
      }),
    ];
    const reader = readerFixture(
      fixture.cards,
      { "card-a": rows },
      [],
      new Map([["conn-a", "2026-07-08"]]),
    );

    const result = await handleListInstalmentPlans(depsWith(fixture.source, reader.reader), { accountId: "card-a" });
    const plan = payload(result).plans[0]!;

    assert.equal(plan.card, "Account card-a");
    assert.equal(plan.instalmentAmount, "9.99");
    assert.equal(plan.purchaseTotal, "20.00");
    assert.equal(plan.remainingTotal, "9.99");
    assert.deepEqual(payload(result).dataThrough, [{ connectionId: "conn-a", through: "2026-07-08" }]);
  });

  it("omits an unknown purchase total while preserving a zero remaining total", async () => {
    const fixture = setup();
    const rows = [
      derived({
        id: "unknown-total",
        accountId: "card-a",
        connectionId: "conn-a",
        accountType: "CREDIT",
        accountSubtype: "CREDIT_CARD",
        localDate: "2026-07-08",
        amountCents: -5_000,
        description: "UNKNOWN",
        descriptionNorm: "UNKNOWN",
        billId: "closed-a",
        instalmentNumber: 2,
        instalmentTotal: 2,
        purchaseDate: "2026-05-28T12:00:00.000Z",
      }),
      derived({
        id: "zero-1",
        accountId: "card-a",
        connectionId: "conn-a",
        accountType: "CREDIT",
        accountSubtype: "CREDIT_CARD",
        localDate: "2026-06-08",
        amountCents: -1_000,
        description: "ZERO",
        descriptionNorm: "ZERO",
        billId: "closed-a",
        instalmentNumber: 1,
        instalmentTotal: 2,
        purchaseDate: "2026-04-28T12:00:00.000Z",
      }),
      derived({
        id: "zero-2",
        accountId: "card-a",
        connectionId: "conn-a",
        accountType: "CREDIT",
        accountSubtype: "CREDIT_CARD",
        localDate: "2026-07-08",
        amountCents: -1_000,
        description: "ZERO",
        descriptionNorm: "ZERO",
        billId: "closed-a",
        instalmentNumber: 2,
        instalmentTotal: 2,
        purchaseDate: "2026-04-28T12:00:00.000Z",
      }),
    ];
    const reader = readerFixture(fixture.cards, { "card-a": rows });

    const result = await handleListInstalmentPlans(
      depsWith(fixture.source, reader.reader),
      { accountId: "card-a", includeSettled: true },
    );
    const plans = payload(result).plans;
    const unknown = plans.find((plan) => plan.merchant === "UNKNOWN")!;
    const zero = plans.find((plan) => plan.merchant === "ZERO")!;

    assert.equal("purchaseTotal" in unknown, false);
    assert.equal(zero.remainingTotal, "0.00");
  });

  it("adds the card-prefixed closing-day remedy without dropping its plans", async () => {
    const card = account("card-b", {
      connectionId: "conn-b",
      type: "CREDIT",
      subtype: "CREDIT_CARD",
      credit: {
        limitCents: 100_000,
        availableLimitCents: 90_000,
        balanceCloseDate: null,
        balanceDueDate: null,
        brand: "Synthetic",
      },
    });
    const source = fakeSource({
      connections: [connection("conn-b")],
      accounts: { "conn-b": [card] },
      bills: { "card-b": [] },
    });
    const reader = readerFixture([card], { "card-b": cardRows("card-b", "conn-b", "OTHER") });
    const result = await handleListInstalmentPlans(depsWith(source, reader.reader), { accountId: "card-b" });
    const response = payload(result);

    assert.deepEqual(response.notes, [
      "Account card-b: no closing day stored for this card; call setClosingDay to get final cycles",
    ]);
    assert.ok(response.plans.some((plan) => plan.accountId === "card-b"));
  });

  it("keeps a reversed plan under includeSettled but excludes it from totals", async () => {
    const card = account("card-r", {
      connectionId: "conn-r",
      name: "Reversed Card",
      type: "CREDIT",
      subtype: "CREDIT_CARD",
      credit: {
        limitCents: 100_000,
        availableLimitCents: 90_000,
        balanceCloseDate: null,
        balanceDueDate: new Date("2026-07-15T03:00:00.000Z"),
        brand: "Synthetic",
      },
    });
    const source = fakeSource({
      connections: [connection("conn-r")],
      accounts: { "conn-r": [card] },
      bills: { "card-r": [bill({ id: "closed-r", closingDate: "2026-07-08", dueDate: "2026-07-15" })] },
    });
    const rows = [
      derived({
        id: "reversed-debit",
        accountId: "card-r",
        connectionId: "conn-r",
        accountType: "CREDIT",
        accountSubtype: "CREDIT_CARD",
        localDate: "2026-06-08",
        amountCents: -8_745,
        description: "REVERSED",
        descriptionNorm: "REVERSED",
        billId: "closed-r",
        instalmentNumber: 1,
        instalmentTotal: 2,
        purchaseDate: "2026-05-28T12:00:00.000Z",
      }),
      derived({
        id: "reversed-credit",
        accountId: "card-r",
        connectionId: "conn-r",
        accountType: "CREDIT",
        accountSubtype: "CREDIT_CARD",
        localDate: "2026-06-08",
        amountCents: 8_745,
        description: "REVERSED",
        descriptionNorm: "REVERSED",
        billId: "closed-r",
        instalmentNumber: 1,
        instalmentTotal: 2,
        purchaseDate: "2026-05-28T01:01:01.000Z",
      }),
    ];
    const reader = readerFixture([card], { "card-r": rows });

    const result = await handleListInstalmentPlans(
      depsWith(source, reader.reader),
      { includeSettled: true },
    );
    const response = payload(result);

    assert.deepEqual(response.plans.map((plan) => plan.status), ["reversed"]);
    assert.deepEqual(response.totals, { planCount: 0, remaining: "0.00" });
  });

  it("returns readable plans and a notice when a connection is unreachable", async () => {
    const fixture = setup();
    const unavailable = [{ connectionId: "conn-b", kind: "unavailable", message: "Connection conn-b timed out." }] as const;
    const reader = readerFixture(fixture.cards.slice(0, 1), { "card-a": cardRows("card-a", "conn-a", "OPEN") }, unavailable);
    const result = await handleListInstalmentPlans(depsWith(fixture.source, reader.reader), {});
    const response = payload(result);

    assert.notEqual(result.isError, true);
    assert.match(response.notice ?? "", /conn-b/);
    assert.deepEqual(response.unavailable, unavailable);
    assert.ok(response.plans.length > 0);
  });
});

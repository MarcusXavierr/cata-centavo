import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { ClosingDayStore } from "../../../src/core/contracts.ts";
import type { DerivedTransaction } from "../../../src/core/transaction.ts";
import type { LoadResult, TransactionReader } from "../../../src/core/transactions.ts";
import type { ToolDeps } from "../../../src/mcp/tools/result.ts";
import { handleGetBills, handleGetBillSummary } from "../../../src/mcp/tools/bills.ts";
import { bill } from "../../fakes/bill-builder.ts";
import { account } from "../../fakes/fake-bank.ts";
import { fakeLogger } from "../../fakes/fake-logger.ts";
import { fakeSource } from "../../fakes/fake-source.ts";
import type { FakeSource } from "../../fakes/fake-source.ts";
import { fixedClock } from "../../fakes/fixed-clock.ts";
import { derived } from "../../fakes/transaction-builder.ts";

function depsWith(
  source: FakeSource = fakeSource(),
  overrides: Partial<Pick<ToolDeps, "reader" | "closingDays" | "clock">> = {},
): ToolDeps {
  return {
    source,
    log: fakeLogger(),
    reader: source.reader,
    writer: source.writer,
    clock: { now: () => new Date() },
    ...overrides,
  };
}

function payload(result: CallToolResult): unknown {
  return JSON.parse(message(result));
}

function message(result: CallToolResult): string {
  const first = result.content[0];
  assert.ok(first !== undefined && first.type === "text");
  return first.text;
}

describe("getBills", () => {
  it("returns an empty bill list as a normal result", async () => {
    const result = await handleGetBills(depsWith(), { accountId: "acc-2" });

    assert.notEqual(result.isError, true);
    assert.deepEqual(payload(result), { bills: [] });
  });

  const LIMIT_CASES: readonly {
    readonly name: string;
    readonly input: { readonly accountId: string; readonly limit?: number };
    readonly expectedCount: number;
  }[] = [
    { name: "an explicit limit", input: { accountId: "acc-2", limit: 3 }, expectedCount: 3 },
    { name: "the default limit", input: { accountId: "acc-2" }, expectedCount: 12 },
  ];

  for (const testCase of LIMIT_CASES) {
    it(`limits the response with ${testCase.name}`, async () => {
      const bills = Array.from({ length: 13 }, (_, index) => bill({ id: `bill-${index + 1}` }));
      const source = fakeSource({ bills: { "acc-2": bills } });

      const result = await handleGetBills(depsWith(source), testCase.input);
      const resultPayload = payload(result) as { readonly bills: readonly { readonly id: string }[] };

      assert.equal(resultPayload.bills.length, testCase.expectedCount);
      assert.deepEqual(
        resultPayload.bills.map(({ id }) => id),
        bills.slice(0, testCase.expectedCount).map(({ id }) => id),
      );
    });
  }

  it("serializes every money amount as a decimal string", async () => {
    const statement = bill({
      totalCents: 12_345,
      minimumPaymentCents: 123,
      financeChargesCents: 456,
      paymentsCents: 789,
      paymentCount: 2,
    });
    const source = fakeSource({ bills: { "acc-2": [statement] } });

    const result = await handleGetBills(depsWith(source), { accountId: "acc-2" });

    assert.deepEqual(payload(result), {
      bills: [{
        id: "bill-1",
        closingDate: "2026-07-08",
        dueDate: "2026-07-15",
        total: "123.45",
        currency: "BRL",
        minimumPayment: "1.23",
        financeCharges: "4.56",
        payments: "7.89",
        paymentCount: 2,
      }],
    });
  });

  it("returns an unknown accountId as readable error content", async () => {
    const result = await handleGetBills(depsWith(), { accountId: "missing-account" });

    assert.equal(result.isError, true);
    assert.match(message(result), /unknown account/i);
  });

  it("refuses an account from an unconfigured connection as unknown", async () => {
    const source = fakeSource({
      accounts: {
        "conn-unconfigured": [
          account("card-unconfigured", {
            connectionId: "conn-unconfigured",
            type: "CREDIT",
            subtype: "CREDIT_CARD",
          }),
        ],
      },
    });

    const result = await handleGetBills(depsWith(source), { accountId: "card-unconfigured" });

    assert.equal(result.isError, true);
    assert.match(message(result), /unknown account/i);
  });

  it("refuses a non-credit account and names its actual type", async () => {
    const result = await handleGetBills(depsWith(), { accountId: "acc-1" });

    assert.equal(result.isError, true);
    assert.match(message(result), /BANK/u);
  });
});

type ReaderFixtureOptions = {
  readonly accounts?: readonly ReturnType<typeof account>[];
  readonly rows?: readonly DerivedTransaction[];
  readonly unavailable?: LoadResult["unavailable"];
  readonly connectionId?: string;
  readonly dataThrough?: string | null;
};

function readerFixture(options: ReaderFixtureOptions = {}): {
  readonly reader: TransactionReader;
  readonly calls: string[];
} {
  const calls: string[] = [];
  const rows = options.rows ?? [];
  const connectionId = options.connectionId ?? "conn-1";
  let through: string | null = "2026-07-20";
  if (options.dataThrough !== undefined) {
    through = options.dataThrough;
  }

  return {
    calls,
    reader: {
      load: async (connectionIds) => {
        calls.push(`load:${connectionIds.join(",")}`);
        return {
          accounts: options.accounts ?? [],
          unavailable: options.unavailable ?? [],
        };
      },
      query: () => [],
      byIds: () => [],
      cardRows: (accountId) => {
        calls.push(`cardRows:${accountId}`);
        return rows;
      },
      dataThrough: (accountIds) => {
        calls.push(`dataThrough:${accountIds.join(",")}`);
        if (through === null) {
          return new Map();
        }
        return new Map([[connectionId, through]]);
      },
    },
  };
}

function closingDays(entries: readonly { readonly accountId: string; readonly day: number }[]): ClosingDayStore {
  return {
    list: () => entries,
    set: () => undefined,
    delete: () => 0,
  };
}

function summaryCard(overrides: Partial<ReturnType<typeof account>> = {}): ReturnType<typeof account> {
  return account("card-summary", {
    connectionId: "conn-1",
    institution: "Synthetic Bank",
    type: "CREDIT",
    subtype: "CREDIT_CARD",
    amountCents: 25_000,
    currency: "BRL",
    lastUpdatedAt: new Date("2026-07-26T15:00:00.000Z"),
    credit: {
      limitCents: 100_000,
      availableLimitCents: 75_000,
      balanceCloseDate: null,
      balanceDueDate: null,
      brand: "Synthetic",
    },
    ...overrides,
  });
}

function sourceForCard(
  card: ReturnType<typeof account>,
  bills: readonly ReturnType<typeof bill>[] = [],
  extra: Parameters<typeof fakeSource>[0] = {},
): FakeSource {
  return fakeSource({
    accounts: { [card.connectionId]: [card] },
    bills: { [card.id]: bills },
    ...extra,
  });
}

function cardRow(overrides: Partial<DerivedTransaction> = {}): DerivedTransaction {
  return derived({
    accountId: "card-summary",
    connectionId: "conn-1",
    accountType: "CREDIT",
    accountSubtype: "CREDIT_CARD",
    occurredAt: "2026-07-20T12:00:00.000Z",
    localDate: "2026-07-20",
    billId: "open-bill",
    billForecastDate: "2026-08",
    categoryId: "11000000",
    ...overrides,
  });
}

function assertOmits(actual: unknown, keys: readonly string[]): void {
  assert.ok(typeof actual === "object" && actual !== null);
  for (const key of keys) {
    assert.equal(key in actual, false, `${key} should have been omitted`);
  }
}

describe("getBillSummary", () => {
  it("loads the card before reading rows and returns both measured figures with their gap and provenance", async () => {
    const card = summaryCard();
    const openBill = bill({
      id: "open-bill",
      closingDate: "2026-08-08",
      dueDate: "2026-08-15",
      totalCents: 2_050,
    });
    const rows = [
      cardRow({ id: "small", amountCents: -100, description: "Small" }),
      cardRow({ id: "largest", amountCents: -600, description: "Largest" }),
      cardRow({ id: "second", amountCents: -500, description: "Second" }),
      cardRow({ id: "third", amountCents: -400, description: "Third" }),
      cardRow({ id: "fourth", amountCents: -300, description: "Fourth" }),
      cardRow({ id: "fifth", amountCents: -200, description: "Fifth" }),
      cardRow({ id: "refund", amountCents: 50, description: "Refund", categoryId: "12000000" }),
      cardRow({
        id: "self-transfer",
        amountCents: -999,
        description: "Bill payment",
        categoryId: "05100000",
      }),
      cardRow({
        id: "future",
        amountCents: -700,
        description: "Future instalment",
        billId: null,
        billForecastDate: "2026-09",
      }),
    ];
    const fixture = readerFixture({ accounts: [card], rows });
    const source = sourceForCard(card, [openBill]);

    const result = await handleGetBillSummary(
      depsWith(source, {
        reader: fixture.reader,
        closingDays: closingDays([]),
        clock: fixedClock(new Date("2026-07-26T12:00:00.000Z")),
      }),
      { accountId: card.id },
    );

    assert.notEqual(result.isError, true);
    assert.deepEqual(fixture.calls, [
      "load:conn-1",
      "cardRows:card-summary",
      "dataThrough:card-summary",
    ]);
    assert.deepEqual(payload(result), {
      accountId: "card-summary",
      institution: "Synthetic Bank",
      currency: "BRL",
      cycle: {
        openCycle: "2026-08",
        closingDate: "2026-08-08",
        dueDate: "2026-08-15",
        closingDateSource: "open-bill",
      },
      utilization: "250.00",
      creditLimit: "1000.00",
      availableLimit: "750.00",
      posted: "20.50",
      committed: "243.00",
      futureInstalments: "7.00",
      gap: "222.50",
      committedIsNegative: false,
      postedExceedsCommitted: false,
      dataThrough: "2026-07-20",
      staleDays: 6,
      topTransactions: [
        { id: "largest", date: "2026-07-20", description: "Largest", amount: "6.00", category: "11000000" },
        { id: "second", date: "2026-07-20", description: "Second", amount: "5.00", category: "11000000" },
        { id: "third", date: "2026-07-20", description: "Third", amount: "4.00", category: "11000000" },
        { id: "fourth", date: "2026-07-20", description: "Fourth", amount: "3.00", category: "11000000" },
        { id: "fifth", date: "2026-07-20", description: "Fifth", amount: "2.00", category: "11000000" },
      ],
    });
  });

  it("uses the published open bill total when its rows include a payment the bank excludes", async () => {
    const card = summaryCard({ amountCents: 26_550 });
    const rows = [
      cardRow({ id: "purchase", amountCents: -26_550 }),
      cardRow({ id: "payment", amountCents: 26_550, categoryId: "08000000" }),
    ];
    const fixture = readerFixture({ accounts: [card], rows });
    const source = sourceForCard(card, [
      bill({ id: "open-bill", closingDate: null, dueDate: "2026-08-15", totalCents: 26_550 }),
    ]);

    const result = await handleGetBillSummary(
      depsWith(source, {
        reader: fixture.reader,
        closingDays: closingDays([]),
        clock: fixedClock(new Date("2026-07-26T12:00:00.000Z")),
      }),
      { accountId: card.id },
    );
    const actual = payload(result) as Record<string, unknown>;

    assert.equal(actual["posted"], "265.50");
  });

  it("uses the locally stored closing day when the bank publishes no bills or cycle dates", async () => {
    const card = summaryCard();
    const rows = [cardRow({ id: "local-cycle", amountCents: -100, billId: null, billForecastDate: "2026-07" })];
    const fixture = readerFixture({ accounts: [card], rows });

    const result = await handleGetBillSummary(
      depsWith(sourceForCard(card), {
        reader: fixture.reader,
        closingDays: closingDays([{ accountId: card.id, day: 31 }]),
        clock: fixedClock(new Date("2026-07-26T12:00:00.000Z")),
      }),
      { accountId: card.id },
    );
    const actual = payload(result) as { readonly cycle: unknown };

    assert.deepEqual(actual.cycle, {
      openCycle: "2026-07",
      closingDate: "2026-07-31",
      closingDateSource: "local",
    });
  });

  it("reports the closing date in the month the cycle closes, not the month it falls due", async () => {
    const card = summaryCard({
      credit: {
        limitCents: 100_000,
        availableLimitCents: 75_000,
        balanceCloseDate: null,
        balanceDueDate: new Date("2026-07-05T03:00:00.000Z"),
        brand: "Synthetic",
      },
    });
    const rows = [cardRow({ id: "local-cycle", amountCents: -100, billId: null, billForecastDate: "2026-08" })];
    const fixture = readerFixture({ accounts: [card], rows });

    const result = await handleGetBillSummary(
      depsWith(sourceForCard(card), {
        reader: fixture.reader,
        closingDays: closingDays([{ accountId: card.id, day: 25 }]),
        clock: fixedClock(new Date("2026-07-10T12:00:00.000Z")),
      }),
      { accountId: card.id },
    );
    const actual = payload(result) as Record<string, unknown>;

    assert.deepEqual(actual["cycle"], {
      openCycle: "2026-08",
      closingDate: "2026-07-25",
      dueDate: "2026-08-05",
      closingDateSource: "local",
    });
    assert.equal(actual["posted"], "1.00");
  });

  it("reports negative and inverted estimates instead of correcting them", async () => {
    const card = summaryCard({ amountCents: 1_000 });
    const rows = [
      cardRow({ id: "open-charge", amountCents: -500 }),
      cardRow({ id: "future-charge", amountCents: -2_000, billId: null, billForecastDate: "2026-09" }),
    ];
    const fixture = readerFixture({ accounts: [card], rows });
    const source = sourceForCard(card, [
      bill({ id: "open-bill", closingDate: "2026-08-08", dueDate: "2026-08-15", totalCents: 500 }),
    ]);

    const result = await handleGetBillSummary(
      depsWith(source, {
        reader: fixture.reader,
        closingDays: closingDays([]),
        clock: fixedClock(new Date("2026-07-26T12:00:00.000Z")),
      }),
      { accountId: card.id },
    );
    const actual = payload(result) as Record<string, unknown>;

    assert.equal(actual["posted"], "5.00");
    assert.equal(actual["committed"], "-10.00");
    assert.equal(actual["gap"], "15.00");
    assert.equal(actual["committedIsNegative"], true);
    assert.equal(actual["postedExceedsCommitted"], true);
  });

  it("refuses a checking account as readable content and names the actual subtype", async () => {
    const result = await handleGetBillSummary(depsWith(), { accountId: "acc-1" });

    assert.equal(result.isError, true);
    assert.match(message(result), /CHECKING_ACCOUNT/u);
    assertOmits(payloadOrMessage(result), ["posted", "committed"]);
  });

  it("returns an unknown accountId as readable content", async () => {
    const result = await handleGetBillSummary(depsWith(), { accountId: "missing-account" });

    assert.equal(result.isError, true);
    assert.match(message(result), /not found/i);
  });

  it("returns utilization only when the card has no cached rows after loading", async () => {
    const card = summaryCard();
    const fixture = readerFixture({ accounts: [card], rows: [], dataThrough: null });

    const result = await handleGetBillSummary(
      depsWith(sourceForCard(card), { reader: fixture.reader, closingDays: closingDays([]) }),
      { accountId: card.id },
    );
    const actual = payload(result) as Record<string, unknown>;

    assert.notEqual(result.isError, true);
    assert.equal(actual["accountId"], card.id);
    assert.equal(actual["utilization"], "250.00");
    assert.match(String(actual["message"]), /never been synced/i);
    assertOmits(actual, ["posted", "committed", "futureInstalments", "gap", "topTransactions", "dataThrough"]);
  });

  it("asks for setClosingDay when no source can identify the cycle", async () => {
    const card = summaryCard();
    const fixture = readerFixture({ accounts: [card], rows: [cardRow({ billId: null })] });

    const result = await handleGetBillSummary(
      depsWith(sourceForCard(card), {
        reader: fixture.reader,
        closingDays: closingDays([]),
        clock: fixedClock(new Date("2026-07-26T12:00:00.000Z")),
      }),
      { accountId: card.id },
    );
    const actual = payload(result) as Record<string, unknown>;

    assert.notEqual(result.isError, true);
    assert.match(String(actual["message"]), /setClosingDay/u);
    assertOmits(actual, ["posted", "committed", "futureInstalments", "gap", "topTransactions"]);
  });

  it("never serializes transaction-derived figures without dataThrough", async () => {
    const card = summaryCard();
    const fixture = readerFixture({
      accounts: [card],
      rows: [cardRow({ id: "future-only", billId: null, billForecastDate: "2026-09" })],
      dataThrough: null,
    });
    const source = sourceForCard(card, [
      bill({ id: "open-bill", closingDate: "2026-08-08", dueDate: "2026-08-15" }),
    ]);

    const result = await handleGetBillSummary(
      depsWith(source, { reader: fixture.reader, closingDays: closingDays([]) }),
      { accountId: card.id },
    );
    const actual = payload(result);

    assert.notEqual(result.isError, true);
    assertOmits(actual, ["posted", "committed", "futureInstalments", "gap", "topTransactions", "dataThrough"]);
  });

  it("returns a revoked consent as readable error content", async () => {
    const card = summaryCard();
    const fixture = readerFixture({
      unavailable: [{
        connectionId: card.connectionId,
        kind: "consent-revoked",
        message: "The consent was revoked.",
      }],
    });

    const result = await handleGetBillSummary(
      depsWith(sourceForCard(card), { reader: fixture.reader, closingDays: closingDays([]) }),
      { accountId: card.id },
    );

    assert.equal(result.isError, true);
    assert.match(message(result), /consent.*revoked/i);
    assert.deepEqual(fixture.calls, ["load:conn-1"]);
  });

  it("leaves transport failures as protocol errors", async () => {
    const card = summaryCard();
    const source = sourceForCard(card, [], {
      unreachable: { [card.id]: new Error("transport offline") },
    });

    await assert.rejects(
      () => handleGetBillSummary(depsWith(source), { accountId: card.id }),
      /transport offline/i,
    );
  });
});

function payloadOrMessage(result: CallToolResult): Record<string, unknown> {
  try {
    const parsed = payload(result);
    if (typeof parsed === "object" && parsed !== null) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return {};
  }
  return {};
}

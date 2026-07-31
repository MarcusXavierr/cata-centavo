import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { deriveInstalmentPlans, type CycleSource, type FigureSource, type PlanStatus } from "../../src/core/instalment-plans.ts";
import type { Bill } from "../../src/core/bill.ts";
import type { DerivedTransaction } from "../../src/core/transaction.ts";
import { bill } from "../fakes/bill-builder.ts";
import { renamedPlanCard } from "../fixtures/renamed-plan-card.ts";
import { annualFeeCard } from "../fixtures/annual-fee-card.ts";
import { repeatedPlanCard } from "../fixtures/repeated-plan-card.ts";
import { reversedInstalmentCard } from "../fixtures/reversed-instalment-card.ts";
import { derived } from "../fakes/transaction-builder.ts";

const CARD = "card-1";
const TODAY = "2026-07-30";

/**
 * One instalment row on the card under test. `id` is required: reversal and ambiguity cases put
 * two rows on one merchant, counter, total and day, and a derived id would collide there.
 */
function instalment(overrides: {
  readonly id: string;
  readonly number: number;
  readonly accountId?: string;
  readonly total: number;
  readonly cents?: number;
  readonly description?: string;
  readonly localDate?: string;
  readonly purchaseDate?: string | null;
  readonly billId?: string | null;
  readonly billForecastDate?: string | null;
}): DerivedTransaction {
  const description = overrides.description ?? "SHOP";
  return derived({
    id: overrides.id,
    accountId: overrides.accountId ?? CARD,
    accountType: "CREDIT",
    accountSubtype: "CREDIT_CARD",
    localDate: overrides.localDate ?? "2026-06-08",
    amountCents: overrides.cents ?? -10_000,
    description,
    descriptionNorm: description,
    billId: overrides.billId ?? null,
    billForecastDate: overrides.billForecastDate ?? null,
    instalmentNumber: overrides.number,
    instalmentTotal: overrides.total,
    purchaseDate: overrides.purchaseDate ?? null,
  });
}

/** Every case in this file derives with no bills and no open cycle unless it says otherwise. */
function derivePlans(rows: readonly DerivedTransaction[]) {
  return deriveInstalmentPlans({ rows, bills: [], openCycle: null, today: TODAY });
}

const IDENTITY_CASES: readonly {
  readonly name: string;
  readonly rows: readonly DerivedTransaction[];
  readonly expected: readonly { readonly merchant: string; readonly instalmentsTotal: number }[];
}[] = [
  {
    name: "rows sharing an instant and a count are one plan",
    rows: [
      instalment({ id: "a1", number: 1, total: 3, purchaseDate: "2026-05-28T14:49:31.000Z", localDate: "2026-05-28" }),
      instalment({ id: "a2", number: 2, total: 3, purchaseDate: "2026-05-28T14:49:31.000Z", localDate: "2026-06-08" }),
    ],
    expected: [{ merchant: "SHOP", instalmentsTotal: 3 }],
  },
  {
    name: "a centavo of drift on the last instalment does not split the plan",
    rows: [
      instalment({ id: "b1", number: 1, total: 2, cents: -36_170, purchaseDate: "2026-04-04T10:00:00.000Z" }),
      instalment({ id: "b2", number: 2, total: 2, cents: -36_169, purchaseDate: "2026-04-04T10:00:00.000Z" }),
    ],
    expected: [{ merchant: "SHOP", instalmentsTotal: 2 }],
  },
  {
    name: "a rename mid-plan does not split the plan, and the later name is reported",
    rows: [
      instalment({ id: "c1", number: 1, total: 2, description: "AMAZON PRIME", purchaseDate: "2025-12-25T13:16:47.001Z" }),
      instalment({ id: "c2", number: 2, total: 2, description: "AMAZON PRIME BR", purchaseDate: "2025-12-25T13:16:47.001Z" }),
    ],
    expected: [{ merchant: "AMAZON PRIME BR", instalmentsTotal: 2 }],
  },
  {
    name: "two merchants sharing a card, a day and a count stay two plans",
    rows: [
      instalment({ id: "d1", number: 1, total: 2, description: "AVIATOR", purchaseDate: "2025-09-13T09:00:00.000Z" }),
      instalment({ id: "d2", number: 2, total: 2, description: "AVIATOR", purchaseDate: "2025-09-13T09:00:00.000Z" }),
      instalment({ id: "d3", number: 1, total: 2, description: "SH RIO SUL", purchaseDate: "2025-09-13T17:30:00.000Z" }),
      instalment({ id: "d4", number: 2, total: 2, description: "SH RIO SUL", purchaseDate: "2025-09-13T17:30:00.000Z" }),
    ],
    expected: [
      { merchant: "AVIATOR", instalmentsTotal: 2 },
      { merchant: "SH RIO SUL", instalmentsTotal: 2 },
    ],
  },
  {
    name: "rows carrying no instalment metadata are ignored",
    rows: [derived({ id: "e1", accountId: CARD, accountType: "CREDIT", amountCents: -5_000 })],
    expected: [],
  },
];

describe("deriveInstalmentPlans identity", () => {
  for (const testCase of IDENTITY_CASES) {
    it(testCase.name, () => {
      const { plans } = derivePlans(testCase.rows);

      assert.deepEqual(
        plans.map(({ merchant, instalmentsTotal }) => ({ merchant, instalmentsTotal })),
        testCase.expected,
      );
    });
  }
});
const CLOSED = bill({ id: "closed-bill", closingDate: "2026-06-08", dueDate: "2026-06-15" });
const OPEN = bill({ id: "open-bill", closingDate: "2026-07-08", dueDate: "2026-07-15" });
const BILLS: readonly Bill[] = [CLOSED, OPEN];
const OPEN_CYCLE = "2026-07";

const POSITION_CASES: readonly {
  readonly name: string;
  readonly rows: readonly DerivedTransaction[];
  readonly openCycle: string | null;
  readonly paid: number;
  readonly remaining: number;
  readonly finalCycle: string | null;
  readonly finalCycleSource: CycleSource;
}[] = [
  {
    name: "an instalment on a closed bill is paid",
    rows: [
      instalment({ id: "f1", number: 1, total: 3, purchaseDate: "P", billId: "closed-bill" }),
      instalment({ id: "f2", number: 2, total: 3, purchaseDate: "P", billId: "open-bill" }),
    ],
    openCycle: OPEN_CYCLE,
    paid: 1,
    remaining: 2,
    finalCycle: "2026-08",
    finalCycleSource: "derived",
  },
  {
    name: "an instalment in the open cycle is remaining, not paid",
    rows: [
      instalment({ id: "g1", number: 1, total: 2, purchaseDate: "P", billId: "open-bill" }),
      instalment({ id: "g2", number: 2, total: 2, purchaseDate: "P", billForecastDate: "2026-08" }),
    ],
    openCycle: OPEN_CYCLE,
    paid: 0,
    remaining: 2,
    finalCycle: "2026-08",
    finalCycleSource: "derived",
  },
  {
    name: "a bill id absent from the card's list neither pays nor anchors",
    rows: [
      instalment({ id: "h1", number: 1, total: 2, purchaseDate: "P", billId: "never-fetched" }),
      instalment({ id: "h2", number: 2, total: 2, purchaseDate: "P", billForecastDate: "2026-08" }),
    ],
    openCycle: OPEN_CYCLE,
    paid: 0,
    remaining: 2,
    finalCycle: null,
    finalCycleSource: "unknown",
  },
  {
    name: "history that begins mid-plan reports its position, not its row count",
    rows: [6, 7].map((number) =>
      instalment({ id: `i${number}`, number, total: 12, purchaseDate: "P", billId: "closed-bill" })),
    openCycle: OPEN_CYCLE,
    paid: 7,
    remaining: 5,
    finalCycle: "2026-11",
    finalCycleSource: "derived",
  },
  {
    name: "a misleading forecast on a later row does not move the final cycle",
    rows: [
      instalment({ id: "j1", number: 1, total: 3, purchaseDate: "P", billId: "closed-bill" }),
      instalment({ id: "j2", number: 2, total: 3, purchaseDate: "P", billForecastDate: "2026-07" }),
      instalment({ id: "j3", number: 3, total: 3, purchaseDate: "P", billForecastDate: "2030-01" }),
    ],
    openCycle: OPEN_CYCLE,
    paid: 1,
    remaining: 2,
    finalCycle: "2026-08",
    finalCycleSource: "derived",
  },
  {
    name: "the final instalment on a placed row reports the cycle rather than deriving it",
    rows: [
      instalment({ id: "k1", number: 1, total: 2, purchaseDate: "P", billId: "closed-bill" }),
      instalment({ id: "k2", number: 2, total: 2, purchaseDate: "P", billId: "open-bill" }),
    ],
    openCycle: OPEN_CYCLE,
    paid: 1,
    remaining: 1,
    finalCycle: "2026-07",
    finalCycleSource: "reported",
  },
  {
    name: "with no open cycle and no billed row, nothing anchors a projection",
    rows: [1, 2].map((number) => instalment({ id: `l${number}`, number, total: 2, purchaseDate: "P" })),
    openCycle: null,
    paid: 0,
    remaining: 2,
    finalCycle: null,
    finalCycleSource: "unknown",
  },
  {
    name: "a plan whose last instalment is paid owes nothing",
    rows: [1, 2].map((number) =>
      instalment({ id: `m${number}`, number, total: 2, purchaseDate: "P", billId: "closed-bill" })),
    openCycle: OPEN_CYCLE,
    paid: 2,
    remaining: 0,
    finalCycle: "2026-06",
    finalCycleSource: "reported",
  },
];

describe("deriveInstalmentPlans positions and cycles", () => {
  for (const testCase of POSITION_CASES) {
    it(testCase.name, () => {
      const { plans } = deriveInstalmentPlans({
        rows: testCase.rows,
        bills: BILLS,
        openCycle: testCase.openCycle,
        today: TODAY,
      });

      assert.equal(plans.length, 1);
      const [plan] = plans;
      assert.ok(plan !== undefined);
      assert.deepEqual(
        {
          paid: plan.instalmentsPaid,
          remaining: plan.instalmentsRemaining,
          finalCycle: plan.finalCycle,
          finalCycleSource: plan.finalCycleSource,
        },
        {
          paid: testCase.paid,
          remaining: testCase.remaining,
          finalCycle: testCase.finalCycle,
          finalCycleSource: testCase.finalCycleSource,
        },
      );
    });
  }
});

const MONEY_CASES: readonly {
  readonly name: string;
  readonly rows: readonly DerivedTransaction[];
  readonly remainingTotalCents: number;
  readonly remainingTotalSource: FigureSource;
  readonly purchaseTotalCents: number | null;
  readonly purchaseTotalSource: FigureSource | null;
}[] = [
  {
    name: "published remaining instalments are summed at their real amounts",
    rows: [
      instalment({ id: "n1", number: 1, total: 3, cents: -10_000, purchaseDate: "P", billId: "closed-bill" }),
      instalment({ id: "n2", number: 2, total: 3, cents: -10_000, purchaseDate: "P", billId: "open-bill" }),
      instalment({ id: "n3", number: 3, total: 3, cents: -9_999, purchaseDate: "P" }),
    ],
    remainingTotalCents: 19_999,
    remainingTotalSource: "reported",
    purchaseTotalCents: 29_999,
    purchaseTotalSource: "reported",
  },
  {
    name: "unpublished instalments are estimated at the latest instalment amount",
    rows: [1, 2].map((number) =>
      instalment({ id: `o${number}`, number, total: 10, cents: -29_990, purchaseDate: "P" })),
    remainingTotalCents: 299_900,
    remainingTotalSource: "estimated",
    purchaseTotalCents: 299_900,
    purchaseTotalSource: "estimated",
  },
  {
    name: "history truncated at the front makes the purchase total unknowable",
    rows: [6, 7].map((number) =>
      instalment({ id: `p${number}`, number, total: 12, cents: -5_500, purchaseDate: "P", billId: "closed-bill" })),
    remainingTotalCents: 27_500,
    remainingTotalSource: "estimated",
    purchaseTotalCents: null,
    purchaseTotalSource: null,
  },
];

describe("deriveInstalmentPlans money", () => {
  for (const testCase of MONEY_CASES) {
    it(testCase.name, () => {
      const { plans } = deriveInstalmentPlans({
        rows: testCase.rows,
        bills: BILLS,
        openCycle: OPEN_CYCLE,
        today: TODAY,
      });

      assert.equal(plans.length, 1);
      const [plan] = plans;
      assert.ok(plan !== undefined);
      assert.deepEqual(
        {
          remainingTotalCents: plan.remainingTotalCents,
          remainingTotalSource: plan.remainingTotalSource,
          purchaseTotalCents: plan.purchaseTotalCents,
          purchaseTotalSource: plan.purchaseTotalSource,
        },
        {
          remainingTotalCents: testCase.remainingTotalCents,
          remainingTotalSource: testCase.remainingTotalSource,
          purchaseTotalCents: testCase.purchaseTotalCents,
          purchaseTotalSource: testCase.purchaseTotalSource,
        },
      );
    });
  }
});

it("projects the renamed twelve-instalment plan onto the December bill", () => {
  const card = renamedPlanCard;
  const { plans } = deriveInstalmentPlans({
    rows: card.rows,
    bills: card.bills,
    openCycle: "2026-08",
    today: card.today,
  });

  assert.equal(plans.length, 1);
  assert.deepEqual(
    plans.map(({ merchant, finalCycle, finalCycleSource }) => ({ merchant, finalCycle, finalCycleSource })),
    [{ merchant: "AMAZON PRIME BR", finalCycle: "2026-12", finalCycleSource: "derived" }],
  );
});

const GROUPING_CASES: readonly {
  readonly name: string;
  readonly rows: readonly DerivedTransaction[];
  readonly expected: readonly {
    readonly instalmentsTotal: number;
    readonly remaining: number;
    readonly renewal: boolean;
  }[];
}[] = [
  {
    name: "a plan straddling two instants comes back whole",
    rows: [
      instalment({ id: "q1", number: 1, total: 3, purchaseDate: "P", localDate: "2026-04-08" }),
      instalment({ id: "q2", number: 2, total: 3, purchaseDate: "P", localDate: "2026-05-08" }),
      instalment({ id: "q3", number: 3, total: 3, purchaseDate: "Q", localDate: "2026-06-08" }),
    ],
    expected: [{ instalmentsTotal: 3, remaining: 3, renewal: false }],
  },
  {
    name: "a residual whose counter every bucket already holds becomes its own plan",
    rows: [
      instalment({ id: "r1", number: 1, total: 2, purchaseDate: "P", localDate: "2026-04-08" }),
      instalment({ id: "r2", number: 2, total: 2, purchaseDate: "P", localDate: "2026-05-08" }),
      instalment({ id: "r3", number: 1, total: 2, purchaseDate: "Q", localDate: "2026-07-25" }),
    ],
    expected: [
      { instalmentsTotal: 2, remaining: 2, renewal: false },
      { instalmentsTotal: 2, remaining: 2, renewal: false },
    ],
  },
  {
    name: "reconciliation is forward-only, so a lower residual does not join",
    rows: [
      instalment({ id: "s2", number: 2, total: 3, purchaseDate: "P", localDate: "2026-05-08" }),
      instalment({ id: "s3", number: 3, total: 3, purchaseDate: "P", localDate: "2026-06-08" }),
      instalment({ id: "s1", number: 1, total: 3, purchaseDate: "Q", localDate: "2026-07-08" }),
    ],
    expected: [
      { instalmentsTotal: 3, remaining: 3, renewal: false },
      { instalmentsTotal: 3, remaining: 3, renewal: false },
    ],
  },
  {
    name: "two purchases of the same size are two plans, and neither is a renewal",
    rows: [
      instalment({ id: "t1", number: 1, total: 10, purchaseDate: "P", localDate: "2026-03-08" }),
      instalment({ id: "t2", number: 1, total: 10, purchaseDate: "Q", localDate: "2026-06-08" }),
    ],
    expected: [
      { instalmentsTotal: 10, remaining: 10, renewal: false },
      { instalmentsTotal: 10, remaining: 10, renewal: false },
    ],
  },
  {
    name: "a restart before the previous run finished is not a renewal",
    rows: [
      ...[1, 2, 3].map((number) =>
        instalment({ id: `u${number}`, number, total: 12, purchaseDate: `U${number}`, localDate: `2026-0${number}-08` })),
      instalment({ id: "u4", number: 1, total: 12, purchaseDate: "U4", localDate: "2026-04-08" }),
    ],
    expected: [
      { instalmentsTotal: 12, remaining: 12, renewal: false },
      { instalmentsTotal: 12, remaining: 12, renewal: false },
    ],
  },
];

describe("deriveInstalmentPlans grouping", () => {
  for (const testCase of GROUPING_CASES) {
    it(testCase.name, () => {
      const { plans } = derivePlans(testCase.rows);

      assert.deepEqual(
        plans.map(({ instalmentsTotal, instalmentsRemaining, renewal }) => ({
          instalmentsTotal,
          remaining: instalmentsRemaining,
          renewal,
        })),
        testCase.expected,
      );
    });
  }
});

it("splits the annual fee at the restart and flags only the second run", () => {
  const card = annualFeeCard;
  const { plans } = deriveInstalmentPlans({
    rows: card.rows,
    bills: card.bills,
    openCycle: "2026-08",
    today: card.today,
  });

  assert.deepEqual(
    plans.map((plan) => ({
      paid: plan.instalmentsPaid,
      remaining: plan.instalmentsRemaining,
      remainingTotalCents: plan.remainingTotalCents,
      purchaseTotalCents: plan.purchaseTotalCents,
      purchaseDate: plan.purchaseDate,
      renewal: plan.renewal,
      status: plan.status,
    })),
    [
      {
        paid: 12,
        remaining: 0,
        remainingTotalCents: 0,
        purchaseTotalCents: null,
        purchaseDate: null,
        renewal: false,
        status: "settled",
      },
      {
        paid: 5,
        remaining: 7,
        remainingTotalCents: 38_500,
        purchaseTotalCents: 66_000,
        purchaseDate: null,
        renewal: true,
        status: "open",
      },
    ],
  );
});

it("keeps a repeated two-instalment merchant as one plan per purchase", () => {
  const card = repeatedPlanCard;
  const { plans } = deriveInstalmentPlans({
    rows: card.rows,
    bills: card.bills,
    openCycle: "2026-08",
    today: card.today,
  });

  assert.equal(plans.length, 6);
  assert.equal(plans.filter(({ instalmentsRemaining }) => instalmentsRemaining === 2).length, 1);
});

const REVERSAL_CASES: readonly {
  readonly name: string;
  readonly rows: readonly DerivedTransaction[];
  readonly statuses: readonly PlanStatus[];
  readonly noteCount: number;
}[] = [
  {
    name: "a plan whose every position is offset is reversed",
    rows: [
      instalment({ id: "v1", number: 1, total: 2, cents: -87_450, billId: "closed-bill" }),
      instalment({ id: "v2", number: 1, total: 2, cents: 87_450, billId: "closed-bill" }),
    ],
    statuses: ["reversed"],
    noteCount: 0,
  },
  {
    name: "a credit on another cycle offsets nothing",
    rows: [
      instalment({ id: "w1", number: 1, total: 2, cents: -87_450, billId: "closed-bill" }),
      instalment({ id: "w2", number: 1, total: 2, cents: 87_450, billId: "open-bill" }),
    ],
    statuses: ["open"],
    noteCount: 1,
  },
  {
    name: "two debit positions matching one credit offset nothing",
    rows: [
      instalment({ id: "x1", number: 1, total: 2, cents: -87_450, billId: "closed-bill", purchaseDate: "X" }),
      instalment({ id: "x2", number: 2, total: 2, cents: -87_450, billId: "closed-bill", purchaseDate: "X" }),
      instalment({ id: "x3", number: 1, total: 2, cents: 87_450, billId: "closed-bill" }),
    ],
    statuses: ["settled"],
    noteCount: 1,
  },
  {
    name: "a refund carrying no instalment metadata leaves the plan alone",
    rows: [
      instalment({ id: "y1", number: 1, total: 2, cents: -26_215, purchaseDate: "Y", billId: "closed-bill" }),
      instalment({ id: "y2", number: 2, total: 2, cents: -26_215, purchaseDate: "Y", billId: "open-bill" }),
      derived({ id: "y3", accountId: CARD, accountType: "CREDIT", amountCents: 50_756, descriptionNorm: "SHOP" }),
    ],
    statuses: ["open"],
    noteCount: 0,
  },
  {
    name: "a credit matching no position forms no plan",
    rows: [instalment({ id: "z1", number: 1, total: 2, cents: 87_450, billId: "closed-bill" })],
    statuses: [],
    noteCount: 1,
  },
];

describe("deriveInstalmentPlans reversals", () => {
  for (const testCase of REVERSAL_CASES) {
    it(testCase.name, () => {
      const { plans, notes } = deriveInstalmentPlans({
        rows: testCase.rows,
        bills: BILLS,
        openCycle: OPEN_CYCLE,
        today: TODAY,
      });

      assert.deepEqual(plans.map(({ status }) => status), testCase.statuses);
      assert.equal(notes.length, testCase.noteCount);
    });
  }

  it("drops an offset position from paid, remaining and both totals without reversing the plan", () => {
    const rows = [
      instalment({ id: "pa1", number: 1, total: 3, cents: -10_000, purchaseDate: "PA", billId: "closed-bill" }),
      instalment({ id: "pa2", number: 2, total: 3, cents: -10_000, purchaseDate: "PA", billId: "closed-bill" }),
      instalment({ id: "pa3", number: 3, total: 3, cents: -10_000, purchaseDate: "PA", billId: "open-bill" }),
      instalment({ id: "pa4", number: 2, total: 3, cents: 10_000, billId: "closed-bill" }),
    ];

    const { plans, notes } = deriveInstalmentPlans({ rows, bills: BILLS, openCycle: OPEN_CYCLE, today: TODAY });

    assert.equal(plans.length, 1);
    const [plan] = plans;
    assert.ok(plan !== undefined);
    assert.equal(plan.status, "open");
    assert.equal(plan.instalmentsPaid, 1);
    assert.equal(plan.instalmentsRemaining, 1);
    assert.equal(plan.remainingTotalCents, 10_000);
    assert.equal(plan.purchaseTotalCents, 20_000);
    assert.equal(notes.length, 1);
  });

  it("keeps the live plan when its neighbour on the same day is reversed", () => {
    const card = reversedInstalmentCard;
    const { plans } = deriveInstalmentPlans({
      rows: card.rows,
      bills: card.bills,
      openCycle: "2026-08",
      today: card.today,
    });

    assert.deepEqual(
      plans.map(({ instalmentsTotal, status }) => ({ instalmentsTotal, status })),
      [{ instalmentsTotal: 3, status: "open" }, { instalmentsTotal: 2, status: "reversed" }],
    );
  });
});

const FIELD_CASES: readonly {
  readonly name: string;
  readonly rows: readonly DerivedTransaction[];
  readonly openCycle: string | null;
  readonly purchaseDate: string | null;
  readonly merchant: string;
  readonly status: PlanStatus;
}[] = [
  {
    name: "a plan whose rows share an instant reports that purchase day",
    rows: [
      instalment({ id: "pd1", number: 1, total: 2, purchaseDate: "2026-05-28T14:49:31.000Z", localDate: "2026-05-28" }),
      instalment({ id: "pd2", number: 2, total: 2, purchaseDate: "2026-05-28T14:49:31.000Z", localDate: "2026-06-28" }),
    ],
    openCycle: null,
    purchaseDate: "2026-05-28",
    merchant: "SHOP",
    status: "open",
  },
  {
    name: "a plan segmented on per-row posting dates reports a null purchase day",
    rows: [
      instalment({ id: "pd3", number: 1, total: 2, purchaseDate: "2026-01-15T10:00:00.000Z", localDate: "2026-01-15" }),
      instalment({ id: "pd4", number: 2, total: 2, purchaseDate: "2026-02-15T10:00:00.000Z", localDate: "2026-02-15" }),
    ],
    openCycle: null,
    purchaseDate: null,
    merchant: "SHOP",
    status: "open",
  },
  {
    name: "a plan with nothing remaining is settled",
    rows: [1, 2].map((number) =>
      instalment({
        id: `pd${number + 4}`,
        number,
        total: 2,
        purchaseDate: "2026-03-10T00:00:00.000Z",
        billId: "closed-bill",
      })),
    openCycle: OPEN_CYCLE,
    purchaseDate: "2026-03-10",
    merchant: "SHOP",
    status: "settled",
  },
  {
    name: "a renamed plan reports the later merchant name",
    rows: [
      instalment({ id: "pd7", number: 1, total: 2, description: "AMAZON PRIME", purchaseDate: "2026-04-10T00:00:00.000Z" }),
      instalment({ id: "pd8", number: 2, total: 2, description: "AMAZON PRIME BR", purchaseDate: "2026-04-10T00:00:00.000Z" }),
    ],
    openCycle: null,
    purchaseDate: "2026-04-10",
    merchant: "AMAZON PRIME BR",
    status: "open",
  },
];

describe("deriveInstalmentPlans presentation fields", () => {
  for (const testCase of FIELD_CASES) {
    it(testCase.name, () => {
      const { plans } = deriveInstalmentPlans({
        rows: testCase.rows,
        bills: BILLS,
        openCycle: testCase.openCycle,
        today: TODAY,
      });

      assert.equal(plans.length, 1);
      const [plan] = plans;
      assert.ok(plan !== undefined);
      assert.deepEqual(
        { purchaseDate: plan.purchaseDate, merchant: plan.merchant, status: plan.status },
        { purchaseDate: testCase.purchaseDate, merchant: testCase.merchant, status: testCase.status },
      );
    });
  }
});

const ORDER_BILLS: readonly Bill[] = [
  bill({ id: "ord-open", closingDate: "2026-07-08", dueDate: "2026-07-15" }),
  bill({ id: "ord-aug", closingDate: "2026-08-08", dueDate: "2026-08-15" }),
  bill({ id: "ord-sep", closingDate: "2026-09-08", dueDate: "2026-09-15" }),
];

/**
 * Six plans whose natural grouping order (oldest localDate first) is the reverse of the expected
 * sort, so a pass actually exercises every comparator key: final cycle ascending with nulls last,
 * remaining total descending, then accountId, then merchant.
 */
it("orders plans by final cycle, then remaining total, then account, then merchant", () => {
  const rows = [
    // null final cycle: both rows point at a bill the card never fetched, so nothing places.
    instalment({ id: "o-null-1", accountId: "card-1", number: 1, total: 2, cents: -2_500, description: "NULLM", purchaseDate: "NULLM", localDate: "2026-07-01", billId: "ghost" }),
    instalment({ id: "o-null-2", accountId: "card-1", number: 2, total: 2, cents: -2_500, description: "NULLM", purchaseDate: "NULLM", localDate: "2026-07-01", billId: "ghost" }),
    // 2026-09 final cycle.
    instalment({ id: "o-eps-1", accountId: "card-1", number: 1, total: 2, cents: -4_500, description: "OMEGA", purchaseDate: "EPS", localDate: "2026-07-02" }),
    instalment({ id: "o-eps-2", accountId: "card-1", number: 2, total: 2, cents: -4_500, description: "OMEGA", purchaseDate: "EPS", localDate: "2026-07-02", billId: "ord-sep" }),
    // 2026-08 final cycle, card-2, smaller amount than the card-1 pair sharing its cycle.
    instalment({ id: "o-delta-1", accountId: "card-2", number: 1, total: 2, cents: -1_500, description: "AAA", purchaseDate: "DELTA", localDate: "2026-07-03" }),
    instalment({ id: "o-delta-2", accountId: "card-2", number: 2, total: 2, cents: -1_500, description: "AAA", purchaseDate: "DELTA", localDate: "2026-07-03", billId: "ord-aug" }),
    // 2026-08 final cycle, card-1, same amount as delta so accountId is what separates them.
    instalment({ id: "o-charlie-1", accountId: "card-1", number: 1, total: 2, cents: -1_500, description: "ZZZ", purchaseDate: "CHARLIE", localDate: "2026-07-04" }),
    instalment({ id: "o-charlie-2", accountId: "card-1", number: 2, total: 2, cents: -1_500, description: "ZZZ", purchaseDate: "CHARLIE", localDate: "2026-07-04", billId: "ord-aug" }),
    // 2026-08 final cycle, card-1, larger amount; merchant tiebreak against ALPHA.
    instalment({ id: "o-bravo-1", accountId: "card-1", number: 1, total: 2, cents: -4_500, description: "BRAVO", purchaseDate: "BRAVO", localDate: "2026-07-05" }),
    instalment({ id: "o-bravo-2", accountId: "card-1", number: 2, total: 2, cents: -4_500, description: "BRAVO", purchaseDate: "BRAVO", localDate: "2026-07-05", billId: "ord-aug" }),
    // 2026-08 final cycle, card-1, larger amount; sorts before BRAVO on merchant.
    instalment({ id: "o-alpha-1", accountId: "card-1", number: 1, total: 2, cents: -4_500, description: "ALPHA", purchaseDate: "ALPHA", localDate: "2026-07-06" }),
    instalment({ id: "o-alpha-2", accountId: "card-1", number: 2, total: 2, cents: -4_500, description: "ALPHA", purchaseDate: "ALPHA", localDate: "2026-07-06", billId: "ord-aug" }),
  ];

  const { plans } = deriveInstalmentPlans({
    rows,
    bills: ORDER_BILLS,
    openCycle: OPEN_CYCLE,
    today: TODAY,
  });

  assert.deepEqual(
    plans.map(({ finalCycle, remainingTotalCents, accountId, merchant }) => ({
      finalCycle,
      remainingTotalCents,
      accountId,
      merchant,
    })),
    [
      { finalCycle: "2026-08", remainingTotalCents: 9_000, accountId: "card-1", merchant: "ALPHA" },
      { finalCycle: "2026-08", remainingTotalCents: 9_000, accountId: "card-1", merchant: "BRAVO" },
      { finalCycle: "2026-08", remainingTotalCents: 3_000, accountId: "card-1", merchant: "ZZZ" },
      { finalCycle: "2026-08", remainingTotalCents: 3_000, accountId: "card-2", merchant: "AAA" },
      { finalCycle: "2026-09", remainingTotalCents: 9_000, accountId: "card-1", merchant: "OMEGA" },
      { finalCycle: null, remainingTotalCents: 5_000, accountId: "card-1", merchant: "NULLM" },
    ],
  );
});
/**
 * A bill whose closing date is in the past counts as closed even when no open cycle could be
 * identified: that is the path `identifyOpenCycle` hands the derivation when it returns null.
 */
describe("deriveInstalmentPlans bill closure without an open cycle", () => {
  it("counts a row on a bill whose closing date passed as paid", () => {
    const { plans } = deriveInstalmentPlans({
      rows: [
        instalment({ id: "cl1", number: 1, total: 2, billId: "past-bill" }),
        instalment({ id: "cl2", number: 2, total: 2, billId: "past-bill" }),
      ],
      bills: [bill({ id: "past-bill", closingDate: "2026-06-08", dueDate: "2026-06-15" })],
      openCycle: null,
      today: TODAY,
    });

    assert.equal(plans.length, 1);
    assert.deepEqual(
      {
        paid: plans[0]?.instalmentsPaid,
        remaining: plans[0]?.instalmentsRemaining,
        finalCycle: plans[0]?.finalCycle,
        finalCycleSource: plans[0]?.finalCycleSource,
        status: plans[0]?.status,
      },
      { paid: 2, remaining: 0, finalCycle: "2026-06", finalCycleSource: "reported", status: "settled" },
    );
  });

  it("leaves a row unpaid when the bill has not closed yet", () => {
    const { plans } = deriveInstalmentPlans({
      rows: [instalment({ id: "fu1", number: 1, total: 2, billId: "future-bill" })],
      bills: [bill({ id: "future-bill", closingDate: "2026-08-08", dueDate: "2026-08-15" })],
      openCycle: null,
      today: TODAY,
    });

    assert.equal(plans.length, 1);
    assert.deepEqual(
      {
        paid: plans[0]?.instalmentsPaid,
        remaining: plans[0]?.instalmentsRemaining,
        finalCycle: plans[0]?.finalCycle,
        finalCycleSource: plans[0]?.finalCycleSource,
        status: plans[0]?.status,
      },
      { paid: 0, remaining: 2, finalCycle: "2026-09", finalCycleSource: "derived", status: "open" },
    );
  });
});

describe("deriveInstalmentPlans bill forecast sentinels", () => {
  it("treats the 0001-01 sentinel as a future row and refuses to place it", () => {
    const { plans } = deriveInstalmentPlans({
      rows: [
        instalment({ id: "fs1", number: 1, total: 2, purchaseDate: "P", billForecastDate: "0001-01" }),
        instalment({ id: "fs2", number: 2, total: 2, purchaseDate: "P", billForecastDate: "0001-01" }),
      ],
      bills: [],
      openCycle: OPEN_CYCLE,
      today: TODAY,
    });

    assert.equal(plans.length, 1);
    assert.deepEqual(
      {
        finalCycle: plans[0]?.finalCycle,
        finalCycleSource: plans[0]?.finalCycleSource,
        remaining: plans[0]?.instalmentsRemaining,
        status: plans[0]?.status,
      },
      { finalCycle: null, finalCycleSource: "unknown", remaining: 2, status: "open" },
    );
  });

  it("places a row with no forecast onto the open cycle", () => {
    const { plans } = deriveInstalmentPlans({
      rows: [
        instalment({ id: "nf1", number: 1, total: 2, purchaseDate: "P", billForecastDate: null }),
        instalment({ id: "nf2", number: 2, total: 2, purchaseDate: "P", billForecastDate: null }),
      ],
      bills: [],
      openCycle: OPEN_CYCLE,
      today: TODAY,
    });

    assert.equal(plans.length, 1);
    assert.deepEqual(
      { finalCycle: plans[0]?.finalCycle, finalCycleSource: plans[0]?.finalCycleSource },
      { finalCycle: "2026-07", finalCycleSource: "reported" },
    );
  });
});

describe("deriveInstalmentPlans reversal notes", () => {
  it("reports an ambiguous reversal and offsets nothing", () => {
    const { plans, notes } = deriveInstalmentPlans({
      rows: [
        instalment({ id: "d1", number: 1, total: 2, cents: -87_450, purchaseDate: "P1", billId: "closed-bill" }),
        instalment({ id: "d2", number: 1, total: 2, cents: -87_450, purchaseDate: "P2", billId: "closed-bill" }),
        instalment({ id: "c1", number: 1, total: 2, cents: 87_450, billId: "closed-bill" }),
      ],
      bills: BILLS,
      openCycle: OPEN_CYCLE,
      today: TODAY,
    });

    assert.deepEqual(plans.map(({ status }) => status), ["open", "open"]);
    assert.equal(notes.length, 1);
    assert.match(notes[0] ?? "", /Ambiguous instalment reversal for credit row c1: matching rows d1, d2/);
  });

  it("reports an unmatched reversal credit that matches no position", () => {
    const { plans, notes } = deriveInstalmentPlans({
      rows: [instalment({ id: "c1", number: 1, total: 2, cents: 87_450, billId: "closed-bill" })],
      bills: BILLS,
      openCycle: OPEN_CYCLE,
      today: TODAY,
    });

    assert.equal(plans.length, 0);
    assert.equal(notes.length, 1);
    assert.match(notes[0] ?? "", /Unmatched instalment reversal credit row c1/);
  });

  it("reports a reversal credit that matches on identity but not on cycle", () => {
    const { plans, notes } = deriveInstalmentPlans({
      rows: [
        instalment({ id: "d1", number: 1, total: 2, cents: -87_450, purchaseDate: "P", billId: "closed-bill" }),
        instalment({ id: "c1", number: 1, total: 2, cents: 87_450, billId: "open-bill" }),
      ],
      bills: BILLS,
      openCycle: OPEN_CYCLE,
      today: TODAY,
    });

    assert.equal(plans.length, 1);
    assert.equal(notes.length, 1);
    assert.match(notes[0] ?? "", /Instalment reversal credit row c1 has no matching established billing cycle/);
  });

  it("names the offset rows in a partial-reversal adjustment note", () => {
    const { notes } = deriveInstalmentPlans({
      rows: [
        instalment({ id: "pa1", number: 1, total: 3, cents: -10_000, purchaseDate: "PA", billId: "closed-bill" }),
        instalment({ id: "pa2", number: 2, total: 3, cents: -10_000, purchaseDate: "PA", billId: "closed-bill" }),
        instalment({ id: "pa3", number: 3, total: 3, cents: -10_000, purchaseDate: "PA", billId: "open-bill" }),
        instalment({ id: "pa4", number: 2, total: 3, cents: 10_000, billId: "closed-bill" }),
      ],
      bills: BILLS,
      openCycle: OPEN_CYCLE,
      today: TODAY,
    });

    assert.ok(notes.some((note) => /Instalment plan adjustment: offset rows pa2/.test(note)));
  });
});

describe("deriveInstalmentPlans reversed-plan money", () => {
  it("a fully reversed plan reports a zero reported purchase total", () => {
    const { plans } = deriveInstalmentPlans({
      rows: [
        instalment({ id: "v1", number: 1, total: 2, cents: -87_450, billId: "closed-bill" }),
        instalment({ id: "v2", number: 1, total: 2, cents: 87_450, billId: "closed-bill" }),
      ],
      bills: BILLS,
      openCycle: OPEN_CYCLE,
      today: TODAY,
    });

    assert.equal(plans.length, 1);
    assert.deepEqual(
      {
        status: plans[0]?.status,
        purchaseTotalCents: plans[0]?.purchaseTotalCents,
        purchaseTotalSource: plans[0]?.purchaseTotalSource,
        remaining: plans[0]?.instalmentsRemaining,
      },
      { status: "reversed", purchaseTotalCents: 0, purchaseTotalSource: "reported", remaining: 0 },
    );
  });
});

describe("deriveInstalmentPlans row filtering", () => {
  it("ignores a debit whose plan length is one", () => {
    const { plans } = derivePlans([instalment({ id: "f-one", number: 1, total: 1, cents: -10_000, purchaseDate: "P" })]);
    assert.equal(plans.length, 0);
  });

  it("ignores a zero-amount debit", () => {
    const { plans } = derivePlans([instalment({ id: "f-zero", number: 1, total: 2, cents: 0, purchaseDate: "P" })]);
    assert.equal(plans.length, 0);
  });

  it("ignores a credit that carries no usable instalment metadata", () => {
    const malformed: readonly (readonly [string, Partial<Parameters<typeof instalment>[0]>])[] = [
      ["zero amount", { cents: 0 }],
      ["null counter", { number: null as unknown as number }],
      ["null total", { total: null as unknown as number }],
      ["single-instalment total", { total: 1 }],
    ];
    for (const [name, overrides] of malformed) {
      const { plans, notes } = derivePlans([
        instalment({ id: "credit", number: 1, total: 2, cents: 5_000, purchaseDate: "P", ...overrides }),
      ]);
      assert.equal(plans.length, 0, `${name} should not form a plan`);
      assert.equal(notes.length, 0, `${name} should not produce a reversal note`);
    }
  });
});

/**
 * Two plans on the same card and cycle whose remaining totals descend in the opposite direction
 * of their merchant names: only the remaining-total comparator puts the larger debt first, so this
 * is what tells it apart from the account-id tiebreak.
 */
it("orders same-cycle, same-account plans by remaining total before merchant", () => {
  const { plans } = deriveInstalmentPlans({
    rows: [
      instalment({ id: "z-1", accountId: "card-1", number: 1, total: 2, cents: -4_500, description: "ZZZ", purchaseDate: "Z" }),
      instalment({ id: "z-2", accountId: "card-1", number: 2, total: 2, cents: -4_500, description: "ZZZ", purchaseDate: "Z", billId: "ord-aug" }),
      instalment({ id: "a-1", accountId: "card-1", number: 1, total: 2, cents: -1_500, description: "AAA", purchaseDate: "A" }),
      instalment({ id: "a-2", accountId: "card-1", number: 2, total: 2, cents: -1_500, description: "AAA", purchaseDate: "A", billId: "ord-aug" }),
    ],
    bills: [bill({ id: "ord-aug", closingDate: "2026-07-08", dueDate: "2026-08-15" })],
    openCycle: OPEN_CYCLE,
    today: TODAY,
  });

  assert.deepEqual(
    plans.map(({ merchant, remainingTotalCents, finalCycle }) => ({ merchant, remainingTotalCents, finalCycle })),
    [
      { merchant: "ZZZ", remainingTotalCents: 9_000, finalCycle: "2026-08" },
      { merchant: "AAA", remainingTotalCents: 3_000, finalCycle: "2026-08" },
    ],
  );
});
/**
 * The per-instalment amount comes from the highest-numbered row, not the last one the iteration
 * touched: feeding the rows oldest-localDate-first puts the top counter first, so only the real
 * maximum picks the amount here.
 */
it("derives the instalment amount from the highest counter, not the last row", () => {
  const { plans } = derivePlans([
    instalment({ id: "h3", number: 3, total: 3, cents: -9_999, purchaseDate: "P", localDate: "2026-04-08" }),
    instalment({ id: "h1", number: 1, total: 3, cents: -10_000, purchaseDate: "P", localDate: "2026-05-08" }),
    instalment({ id: "h2", number: 2, total: 3, cents: -10_000, purchaseDate: "P", localDate: "2026-06-08" }),
  ]);

  assert.equal(plans.length, 1);
  assert.deepEqual(
    {
      instalmentAmountCents: plans[0]?.instalmentAmountCents,
      remainingTotalCents: plans[0]?.remainingTotalCents,
      remaining: plans[0]?.instalmentsRemaining,
    },
    { instalmentAmountCents: 9_999, remainingTotalCents: 29_999, remaining: 3 },
  );
});

/**
 * The final cycle anchors on the highest counter that a bill places: here counter 3 sits on the
 * open bill, so the cycle is reported rather than projected forward from an earlier counter.
 */
it("anchors the final cycle on the highest counter a bill places", () => {
  const { plans } = deriveInstalmentPlans({
    rows: [
      instalment({ id: "a3", number: 3, total: 3, purchaseDate: "P", billId: "open-bill", localDate: "2026-04-08" }),
      instalment({ id: "a1", number: 1, total: 3, purchaseDate: "P", billId: "closed-bill", localDate: "2026-05-08" }),
      instalment({ id: "a2", number: 2, total: 3, purchaseDate: "P", billId: "closed-bill", localDate: "2026-06-08" }),
    ],
    bills: BILLS,
    openCycle: OPEN_CYCLE,
    today: TODAY,
  });

  assert.equal(plans.length, 1);
  assert.deepEqual(
    { finalCycle: plans[0]?.finalCycle, finalCycleSource: plans[0]?.finalCycleSource },
    { finalCycle: "2026-07", finalCycleSource: "reported" },
  );
});
describe("deriveInstalmentPlans bill closure edge dates", () => {
  it("counts a bill whose closing date is today as still open", () => {
    const { plans } = deriveInstalmentPlans({
      rows: [instalment({ id: "t1", number: 1, total: 2, billId: "today-bill" })],
      bills: [bill({ id: "today-bill", closingDate: TODAY, dueDate: "2026-07-15" })],
      openCycle: null,
      today: TODAY,
    });

    assert.equal(plans.length, 1);
    assert.deepEqual(
      { paid: plans[0]?.instalmentsPaid, status: plans[0]?.status },
      { paid: 0, status: "open" },
    );
  });
});

describe("deriveInstalmentPlans bill forecast on the open cycle", () => {
  it("places a row whose forecast equals the open cycle rather than treating it as future", () => {
    const { plans } = deriveInstalmentPlans({
      rows: [
        instalment({ id: "fe1", number: 1, total: 2, purchaseDate: "P", billForecastDate: OPEN_CYCLE }),
        instalment({ id: "fe2", number: 2, total: 2, purchaseDate: "P", billForecastDate: OPEN_CYCLE }),
      ],
      bills: [],
      openCycle: OPEN_CYCLE,
      today: TODAY,
    });

    assert.equal(plans.length, 1);
    assert.deepEqual(
      { finalCycle: plans[0]?.finalCycle, finalCycleSource: plans[0]?.finalCycleSource },
      { finalCycle: "2026-07", finalCycleSource: "reported" },
    );
  });
});

it("counts paid instalments from the highest counter on a closed bill", () => {
  const { plans } = deriveInstalmentPlans({
    rows: [
      instalment({ id: "p3", number: 3, total: 3, purchaseDate: "P", billId: "closed-bill", localDate: "2026-04-08" }),
      instalment({ id: "p1", number: 1, total: 3, purchaseDate: "P", billId: "closed-bill", localDate: "2026-05-08" }),
      instalment({ id: "p2", number: 2, total: 3, purchaseDate: "P", billId: "closed-bill", localDate: "2026-06-08" }),
    ],
    bills: BILLS,
    openCycle: OPEN_CYCLE,
    today: TODAY,
  });

  assert.equal(plans.length, 1);
  assert.deepEqual(
    { paid: plans[0]?.instalmentsPaid, remaining: plans[0]?.instalmentsRemaining, status: plans[0]?.status },
    { paid: 3, remaining: 0, status: "settled" },
  );
});

it("keeps the first row when a plan has a duplicated counter", () => {
  const { plans } = derivePlans([
    instalment({ id: "d1b", number: 1, total: 2, cents: -9_999, purchaseDate: "P", localDate: "2026-06-08" }),
    instalment({ id: "d1a", number: 1, total: 2, cents: -10_000, purchaseDate: "P", localDate: "2026-05-08" }),
    instalment({ id: "d2", number: 2, total: 2, cents: -10_000, purchaseDate: "P", localDate: "2026-07-08" }),
  ]);

  assert.equal(plans.length, 1);
  assert.deepEqual(
    { purchaseTotalCents: plans[0]?.purchaseTotalCents, remainingTotalCents: plans[0]?.remainingTotalCents },
    { purchaseTotalCents: 20_000, remainingTotalCents: 20_000 },
  );
});

describe("deriveInstalmentPlans reversal identity", () => {
  const fieldCases: readonly { readonly name: string; readonly credit: Partial<Parameters<typeof instalment>[0]> }[] = [
    { name: "amount", credit: { cents: 9_999 } },
    { name: "card", credit: { accountId: "other-card" } },
    { name: "name", credit: { description: "SHOPX" } },
    { name: "total", credit: { total: 3 } },
  ];

  for (const { name, credit } of fieldCases) {
    it(`does not offset a credit that differs only on ${name}`, () => {
      const { plans, notes } = deriveInstalmentPlans({
        rows: [
          instalment({ id: "d1", number: 1, total: 2, cents: -10_000, purchaseDate: "P", billId: "closed-bill" }),
          instalment({ id: "c1", number: 1, total: 2, cents: 10_000, billId: "closed-bill", ...credit }),
        ],
        bills: BILLS,
        openCycle: OPEN_CYCLE,
        today: TODAY,
      });

      assert.equal(plans.length, 1);
      assert.equal(plans[0]?.status, "open");
      assert.ok(notes.some((note) => /Unmatched instalment reversal credit row c1/.test(note)), `${name} should leave the credit unmatched`);
    });
  }

  it("does not reverse a debit that has no established cycle", () => {
    const { plans, notes } = deriveInstalmentPlans({
      rows: [
        instalment({ id: "d1", number: 1, total: 2, cents: -87_450, purchaseDate: "P" }),
        instalment({ id: "c1", number: 1, total: 2, cents: 87_450 }),
      ],
      bills: [],
      openCycle: null,
      today: TODAY,
    });

    assert.equal(plans.length, 1);
    assert.equal(plans[0]?.status, "open");
    assert.ok(notes.some((note) => /has no matching established billing cycle/.test(note)));
  });

  it("lists every offset row in a multi-position adjustment note", () => {
    const { notes } = deriveInstalmentPlans({
      rows: [
        instalment({ id: "m1", number: 1, total: 3, cents: -10_000, purchaseDate: "PA", billId: "closed-bill" }),
        instalment({ id: "m2", number: 2, total: 3, cents: -10_000, purchaseDate: "PA", billId: "closed-bill" }),
        instalment({ id: "m3", number: 3, total: 3, cents: -10_000, purchaseDate: "PA", billId: "open-bill" }),
        instalment({ id: "c2", number: 2, total: 3, cents: 10_000, billId: "closed-bill" }),
        instalment({ id: "c3", number: 3, total: 3, cents: 10_000, billId: "open-bill" }),
      ],
      bills: BILLS,
      openCycle: OPEN_CYCLE,
      today: TODAY,
    });

    assert.ok(notes.some((note) => /Instalment plan adjustment: offset rows m2, m3/.test(note)));
  });
});

describe("deriveInstalmentPlans grouping reconciliation", () => {
  it("reports an ambiguous reconciliation when two equal buckets compete for a row", () => {
    const { plans, notes } = derivePlans([
      instalment({ id: "b1a", number: 1, total: 3, purchaseDate: "P1", localDate: "2026-04-08" }),
      instalment({ id: "b1b", number: 2, total: 3, purchaseDate: "P1", localDate: "2026-04-08" }),
      instalment({ id: "b2a", number: 1, total: 3, purchaseDate: "P2", localDate: "2026-04-08" }),
      instalment({ id: "b2b", number: 2, total: 3, purchaseDate: "P2", localDate: "2026-04-08" }),
      instalment({ id: "r3", number: 3, total: 3, localDate: "2026-04-08" }),
    ]);

    assert.equal(plans.length, 3);
    assert.ok(notes.some((note) => /Ambiguous instalment reconciliation for row r3/.test(note)));
  });

  it("does not absorb a residual whose merchant name the bucket does not share", () => {
    const { plans } = derivePlans([
      instalment({ id: "n1", number: 1, total: 2, purchaseDate: "P", localDate: "2026-04-08", description: "SHOP" }),
      instalment({ id: "n2", number: 2, total: 2, purchaseDate: "P", localDate: "2026-05-08", description: "SHOP" }),
      instalment({ id: "nr", number: 3, total: 2, localDate: "2026-06-08", description: "OTHER" }),
    ]);

    assert.deepEqual(
      plans.map(({ merchant }) => merchant),
      ["OTHER", "SHOP"],
    );
  });

  it("groups residuals into per-merchant segments", () => {
    const { plans } = derivePlans([
      instalment({ id: "m1", number: 1, total: 2, description: "AAA" }),
      instalment({ id: "m2", number: 1, total: 2, description: "BBB" }),
    ]);

    assert.deepEqual(
      plans.map(({ merchant }) => merchant),
      ["AAA", "BBB"],
    );
  });

  it("groups residuals that share an instant even without a purchase date", () => {
    const { plans } = derivePlans([
      instalment({ id: "z1", number: 1, total: 3, localDate: "2026-04-08" }),
      instalment({ id: "z2", number: 2, total: 3, localDate: "2026-05-08" }),
      instalment({ id: "z3", number: 1, total: 3, localDate: "2026-06-08" }),
    ]);

    assert.equal(plans.length, 2);
  });
});
it("does not flag a renewal when the second run restarts above one", () => {
  const { plans } = derivePlans([
    instalment({ id: "a1", number: 1, total: 2, description: "FEE", localDate: "2026-04-08" }),
    instalment({ id: "a2", number: 2, total: 2, description: "FEE", localDate: "2026-05-08" }),
    instalment({ id: "b2", number: 2, total: 2, description: "FEE", localDate: "2026-06-08" }),
  ]);

  assert.deepEqual(
    plans.map(({ instalmentsTotal, renewal }) => ({ instalmentsTotal, renewal })),
    [
      { instalmentsTotal: 2, renewal: false },
      { instalmentsTotal: 2, renewal: false },
    ],
  );
});

it("ignores a debit whose instalment counter is missing", () => {
  const { plans } = derivePlans([
    derived({
      id: "x1",
      accountId: CARD,
      accountType: "CREDIT",
      accountSubtype: "CREDIT_CARD",
      localDate: "2026-06-08",
      amountCents: -5_000,
      description: "SHOP",
      descriptionNorm: "SHOP",
      instalmentNumber: null,
      instalmentTotal: 5,
      purchaseDate: "P",
    }),
  ]);

  assert.equal(plans.length, 0);
});

describe("deriveInstalmentPlans grouping selection", () => {
  it("attaches an otherwise identical residual to the most recently advanced purchase", () => {
    const { plans } = derivePlans([
      instalment({ id: "older-1", number: 1, total: 3, cents: -1_000, purchaseDate: "older", localDate: "2026-04-08" }),
      instalment({ id: "older-2", number: 2, total: 3, cents: -1_000, purchaseDate: "older", localDate: "2026-05-08" }),
      instalment({ id: "newer-1", number: 1, total: 3, cents: -2_000, purchaseDate: "newer", localDate: "2026-06-08" }),
      instalment({ id: "newer-2", number: 2, total: 3, cents: -2_000, purchaseDate: "newer", localDate: "2026-07-08" }),
      instalment({ id: "residual-3", number: 3, total: 3, cents: -2_000, localDate: "2026-08-08" }),
    ]);

    assert.deepEqual(
      plans.map(({ instalmentAmountCents, remainingTotalCents }) => ({ instalmentAmountCents, remainingTotalCents })),
      [
        { instalmentAmountCents: 2_000, remainingTotalCents: 6_000 },
        { instalmentAmountCents: 1_000, remainingTotalCents: 3_000 },
      ],
    );
  });

  for (const mismatch of [
    { name: "card", residual: { accountId: "other-card" } },
    { name: "plan length", residual: { total: 4 } },
    { name: "counter already in the bucket", residual: { number: 2 } },
  ] as const) {
    it(`does not reconcile a residual with a conflicting ${mismatch.name}`, () => {
      const { plans } = derivePlans([
        instalment({ id: "bucket-1", number: 1, total: 3, cents: -1_000, purchaseDate: "bucket", localDate: "2026-04-08" }),
        instalment({ id: "bucket-2", number: 2, total: 3, cents: -1_000, purchaseDate: "bucket", localDate: "2026-05-08" }),
        instalment({ id: "residual", number: 3, total: 3, cents: -2_000, localDate: "2026-06-08", ...mismatch.residual }),
      ]);

      assert.equal(plans.length, 2);
      assert.ok(plans.some(({ instalmentAmountCents }) => instalmentAmountCents === 1_000));
      assert.ok(plans.some(({ instalmentAmountCents }) => instalmentAmountCents === 2_000));
    });
  }

  it("keeps residual purchases from different cards separate", () => {
    const { plans } = derivePlans([
      instalment({ id: "card-1", number: 1, total: 2, accountId: "card-1", cents: -1_000, description: "SAME" }),
      instalment({ id: "card-2", number: 1, total: 2, accountId: "card-2", cents: -2_000, description: "SAME" }),
    ]);

    assert.deepEqual(
      plans.map(({ accountId, instalmentAmountCents }) => ({ accountId, instalmentAmountCents })),
      [
        { accountId: "card-2", instalmentAmountCents: 2_000 },
        { accountId: "card-1", instalmentAmountCents: 1_000 },
      ],
    );
  });

  it("reconciles residual counters in numerical order rather than posting order", () => {
    const { plans } = derivePlans([
      instalment({ id: "bucket-1", number: 1, total: 4, cents: -1_000, purchaseDate: "bucket", localDate: "2026-04-08" }),
      instalment({ id: "bucket-2", number: 2, total: 4, cents: -1_000, purchaseDate: "bucket", localDate: "2026-05-08" }),
      instalment({ id: "residual-4", number: 4, total: 4, cents: -4_000, localDate: "2026-06-08" }),
      instalment({ id: "residual-3", number: 3, total: 4, cents: -3_000, localDate: "2026-07-08" }),
    ]);

    assert.deepEqual(
      plans.map(({ instalmentsTotal, remainingTotalCents }) => ({ instalmentsTotal, remainingTotalCents })),
      [{ instalmentsTotal: 4, remainingTotalCents: 9_000 }],
    );
  });

  it("keeps the lowest id when duplicate rows share a posting date", () => {
    const { plans } = derivePlans([
      instalment({ id: "z-duplicate", number: 1, total: 2, cents: -9_999, purchaseDate: "P", localDate: "2026-06-08" }),
      instalment({ id: "a-duplicate", number: 1, total: 2, cents: -10_000, purchaseDate: "P", localDate: "2026-06-08" }),
      instalment({ id: "second", number: 2, total: 2, cents: -10_000, purchaseDate: "P", localDate: "2026-07-08" }),
    ]);

    assert.deepEqual(
      plans.map(({ purchaseTotalCents }) => purchaseTotalCents),
      [20_000],
    );
  });

  it("reconciles a residual against any prior spelling in its bucket", () => {
    const { plans } = derivePlans([
      instalment({ id: "old", number: 1, total: 3, description: "SHOP OLD", purchaseDate: "P", localDate: "2026-04-08" }),
      instalment({ id: "new", number: 2, total: 3, description: "SHOP NEW", purchaseDate: "P", localDate: "2026-05-08" }),
      instalment({ id: "residual", number: 3, total: 3, description: "SHOP OLD", localDate: "2026-06-08" }),
    ]);

    assert.deepEqual(
      plans.map(({ merchant, instalmentsTotal }) => ({ merchant, instalmentsTotal })),
      [{ merchant: "SHOP OLD", instalmentsTotal: 3 }],
    );
  });

  it("chooses the furthest advanced bucket and ignores a lower-ranked later candidate", () => {
    const { plans } = derivePlans([
      instalment({ id: "first-1", number: 1, total: 4, cents: -1_000, purchaseDate: "first", localDate: "2026-07-08" }),
      instalment({ id: "first-2", number: 2, total: 4, cents: -1_000, purchaseDate: "first", localDate: "2026-07-09" }),
      instalment({ id: "winner-1", number: 1, total: 4, cents: -2_000, purchaseDate: "winner", localDate: "2026-04-08" }),
      instalment({ id: "winner-2", number: 2, total: 4, cents: -2_000, purchaseDate: "winner", localDate: "2026-04-09" }),
      instalment({ id: "winner-3", number: 3, total: 4, cents: -2_000, purchaseDate: "winner", localDate: "2026-04-10" }),
      instalment({ id: "last-1", number: 1, total: 4, cents: -3_000, purchaseDate: "last", localDate: "2026-03-08" }),
      instalment({ id: "last-2", number: 2, total: 4, cents: -3_000, purchaseDate: "last", localDate: "2026-03-09" }),
      instalment({ id: "residual", number: 4, total: 4, cents: -4_000, localDate: "2026-08-08" }),
    ]);

    assert.deepEqual(
      plans.map(({ remainingTotalCents }) => remainingTotalCents),
      [12_000, 10_000, 4_000],
    );
  });

  it("keeps colliding unseparated account and merchant strings as separate plans", () => {
    const { plans } = derivePlans([
      instalment({ id: "a-1", number: 1, total: 2, accountId: "A", description: "BC", localDate: "2026-04-08" }),
      instalment({ id: "a-2", number: 2, total: 2, accountId: "A", description: "BC", localDate: "2026-05-08" }),
      instalment({ id: "ab-1", number: 1, total: 2, accountId: "AB", description: "C", localDate: "2026-06-08" }),
      instalment({ id: "ab-2", number: 2, total: 2, accountId: "AB", description: "C", localDate: "2026-07-08" }),
    ]);

    assert.deepEqual(
      plans.map(({ accountId, merchant }) => ({ accountId, merchant })),
      [
        { accountId: "A", merchant: "BC" },
        { accountId: "AB", merchant: "C" },
      ],
    );
  });

  it("keeps plan lengths separate when a merchant name ends in digits", () => {
    const { plans } = derivePlans([
      instalment({ id: "long-1", number: 1, total: 22, accountId: "A", description: "BC", localDate: "2026-04-08" }),
      instalment({ id: "short-1", number: 1, total: 2, accountId: "A", description: "BC2", localDate: "2026-05-08" }),
      instalment({ id: "long-2", number: 2, total: 22, accountId: "A", description: "BC", localDate: "2026-06-08" }),
      instalment({ id: "short-2", number: 2, total: 2, accountId: "A", description: "BC2", localDate: "2026-07-08" }),
    ]);

    assert.deepEqual(
      plans.map(({ instalmentsTotal }) => instalmentsTotal),
      [22, 2],
    );
  });
});

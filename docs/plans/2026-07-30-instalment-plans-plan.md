# listInstalmentPlans Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ship a `listInstalmentPlans` MCP tool that reconstructs credit card instalment purchases from the cached rows and reports what is still owed, what the purchase cost in total, and which billing cycle each plan ends on.

**Architecture:** One pure function, `deriveInstalmentPlans` in `src/core/instalment-plans.ts`, takes a card's rows plus its bills, its open cycle and today, and returns plans with notes. It touches no store, no clock and no network, so every rule is unit-testable against synthetic rows. Three thin slices in `src/mcp/tools/instalment-plans.ts` resolve accounts, fetch bills per card, call the function, and serialize. The new module imports nothing from `src/core/bill-rows.ts`; unifying the two groupings is ticket 03.

**Tech Stack:** TypeScript on Node 24 with native type stripping, `node --test`, Zod at the MCP boundary, no new dependencies.

---

## Before you start

Read, in this order:

1. `docs/plans/2026-07-30-instalment-plans-design.md`, the design this plan implements. Every rule below traces to a section there. If the plan and the design disagree, stop and ask; do not guess.
2. `AGENTS.md`, the repo's binding conventions.
3. `src/core/bill-rows.ts` and `src/core/bill.ts`, the neighbouring derivation, for tone and for what *not* to import.

Then set up the runtime:

```bash
source ~/.nvm/nvm.sh && nvm use
```

This is not optional. The machine's default Node is 18, and on Node 18 `npm test` prints `# tests 0` and exits `0`. A green run that executed nothing is the failure mode you will not notice.

Non-negotiable conventions this plan assumes:

- No `enum`, no parameter properties. Use a `const` object plus a derived union.
- Relative imports carry the `.ts` extension.
- Money is integer cents inside, decimal strings only at the MCP boundary.
- Comments are docblocks on exported symbols. Do not narrate the next three lines.
- Everything in English.
- Do not commit unless the user asks.

### The gate at the end of every step

Every task below ends the same way: read the sensors, then commit. Nothing gets committed over a red sensor.

The sidecar runs the quality suite on intervals in the background and answers with one table instead of six commands' worth of output. Start it once, at the top of the session:

```bash
.sensors/cli.sh start .
```

Then at the end of each step:

```bash
.sensors/cli.sh check .
```

**Always go through `.sensors/cli.sh`, never a bare `sensors`.** Fedora's `lm_sensors` package owns `/usr/bin/sensors`, so on this machine the name belongs to two programs and which one answers depends on PATH order. It works in an interactive shell and fails in anything with a sanitized environment. The wrapper resolves the right one and forwards.

Eight runners are configured in `.sensors/cata-centavo.sensors.yaml`:

| Runner | Mode | What a red row means |
|---|---|---|
| `tests` | interval, 8s | The suite is failing. Blocks the commit. |
| `lint` | interval, 11s | ESLint. Warnings inform; errors block. |
| `types` | interval, 17s | `tsc --noEmit`. Fails the build. Blocks. |
| `structure` | interval, 23s | dependency-cruiser. Fails the build. Blocks. |
| `cov` | interval, 41s | Informational. Read it, do not chase it. |
| `security` | interval, 97s | semgrep over `src`. Blocks until resolved or explicitly understood. |
| `mutation` | triggered | Stryker, ~48s. Not on a clock; `start` fires it once. |
| `mut_state` | on check | The *last* mutation result, which may predate your change. Informational. |

**Resolve every failing row before you commit**, not just `types` and `structure`. `cov` and `mut_state` are the only two that are purely informational. `check` exits 1 when a sensor failed, and a `Stop` hook in `.claude/settings.json` runs it at the end of every turn regardless.

The sidecar is optional infrastructure, not a dependency. When it is not installed `check` exits 127, and you fall back to running the gates by hand, in the order CI uses:

```bash
npm run typecheck && npm run lint && npm run deps && npm test && npm run build
```

Either way, run the single test file while iterating. The `tests` runner is on an eight-second interval and you want the failure now:

```bash
node --test tests/core/instalment-plans.test.ts
```

## Reuse, do not reinvent

There is already machinery for all of this. Using it is a requirement, not a suggestion.

| Need | Use | Where |
|---|---|---|
| A synthetic transaction row | `derived({ ... })` | `tests/fakes/transaction-builder.ts` |
| A synthetic bill | `bill({ ... })` | `tests/fakes/bill-builder.ts` |
| A whole card: account, bills, rows, clock | `billFixture({ ... })` | `tests/fakes/bill-builder.ts` |
| Cents to a decimal string | `toDecimal` | `src/mcp/format.ts` |
| Serializing a tool response | `textResult` | `src/mcp/tools/result.ts` |
| Today in the stored calendar | `todayIn(deps.clock)` | `src/core/date.ts` |
| The open cycle | `identifyOpenCycle` | `src/core/bill.ts` |
| Card identity fields on the wire | `formatSummaryBase(account)` | `src/mcp/tools/bill-summary-format.ts` |
| Resolving and refreshing accounts | `reader.load(connectionIds)` | `src/core/transactions.ts` |

Core tests go in **one** new file, `tests/core/instalment-plans.test.ts`. MCP tests go in **one** new file, `tests/mcp/tools/instalment-plans.test.ts`, matching the repo's one-file-per-tool layout. Do not create a file per task.

**Multi-row scenarios become fixtures**, not inline arrays. `tests/fixtures/` already holds `bulk-posting-card.ts`, `materializing-card.ts` and `one-per-bill-card.ts` for exactly this. Four new ones appear in the tasks below. The local `instalment()` helper stays for small one- and two-row cases.

Every task adds **cases to an existing table**. `tests/core/bill-rows.test.ts` shows the shape: a `const X_CASES: readonly {...}[]` array, then one `describe` with one `it` loop. A fourth near-identical `it()` block means you have gone wrong.

## Task order, and why

Identity has to produce plans before anything can be asserted about them, so grouping lands first and completely (Tasks 1 and 4) before reversals (Task 5) touch it. Money (Task 3) rides on positions (Task 2). Ordering it any other way gives tasks whose RED state is "no plans at all", which proves nothing.

---

## Task 1: The module, and identity by shared purchase instant

**Files:**
- Create: `src/core/instalment-plans.ts`
- Create: `tests/core/instalment-plans.test.ts`

Rows sharing an account, an untruncated `purchaseDate` instant and an instalment count are one purchase. That is the strongest signal the feed offers, and it is the only one this task implements.

**Step 1: Write the failing test**

Create `tests/core/instalment-plans.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { deriveInstalmentPlans } from "../../src/core/instalment-plans.ts";
import type { DerivedTransaction } from "../../src/core/transaction.ts";
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
    accountId: CARD,
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
```

Two merchants come back in a defined order because Task 6 makes the ordering total. Until then the derivation emits them in first-seen order, which for this table is alphabetical by construction; do not add a sort to the assertion.

**Step 2: Run it and watch it fail**

```bash
node --test tests/core/instalment-plans.test.ts
```

Expected: it fails to resolve `../../src/core/instalment-plans.ts`. That is the correct first failure.

**Step 3: Write the minimal implementation**

Create `src/core/instalment-plans.ts`. The exported types and `buildPlan`'s signature are **final here and do not change in later tasks**; only the bodies grow.

```ts
import type { Bill } from "./bill.ts";
import type { DerivedTransaction } from "./transaction.ts";

/** Whether a money figure was published by the bank or projected from the instalments that were. */
export type FigureSource = "reported" | "estimated";

/** Whether the final cycle came from a placed row, a projection, or nothing at all. */
export type CycleSource = "reported" | "derived" | "unknown";

export type PlanStatus = "open" | "settled" | "reversed";

export type InstalmentPlan = {
  readonly accountId: string;
  readonly merchant: string;
  readonly purchaseDate: string | null;
  readonly purchaseTotalCents: number | null;
  readonly purchaseTotalSource: FigureSource | null;
  readonly instalmentAmountCents: number;
  readonly instalmentsPaid: number;
  readonly instalmentsTotal: number;
  readonly instalmentsRemaining: number;
  readonly remainingTotalCents: number;
  readonly remainingTotalSource: FigureSource;
  readonly finalCycle: string | null;
  readonly finalCycleSource: CycleSource;
  readonly status: PlanStatus;
  readonly renewal: boolean;
};

export type InstalmentPlanDerivation = {
  readonly plans: readonly InstalmentPlan[];
  /** Ambiguities the rules refuse to resolve silently. */
  readonly notes: readonly string[];
};

export type InstalmentPlanInput = {
  readonly rows: readonly DerivedTransaction[];
  readonly bills: readonly Bill[];
  /** The cycle currently accumulating, tagged by the month it falls due, or null when unidentifiable. */
  readonly openCycle: string | null;
  readonly today: string;
};

/** One instalment row, with its counter narrowed to a number. */
type PlanRow = {
  readonly row: DerivedTransaction;
  readonly number: number;
  readonly total: number;
};

/**
 * A plan's rows. Non-empty by construction: buckets carry two or more and segments carry at least
 * one, so `buildPlan` never has to invent an identity for nothing.
 */
type PlanGroup = readonly [PlanRow, ...PlanRow[]];

/**
 * Reconstructs instalment purchases from a card's rows.
 *
 * The feed carries no plan id, so identity is derived. `docs/plans/2026-07-30-instalment-plans-design.md`
 * records why each obvious key fails on real rows and what replaces them.
 */
export function deriveInstalmentPlans(input: InstalmentPlanInput): InstalmentPlanDerivation {
  const { buckets } = bucketByInstant(debitRows(input.rows));

  return { plans: buckets.map((group) => buildPlan(group)), notes: [] };
}

/** Debit rows carrying a usable counter, oldest first. Ties break on id so the order is total. */
function debitRows(rows: readonly DerivedTransaction[]): readonly PlanRow[] {
  const planRows: PlanRow[] = [];
  for (const row of rows) {
    if (row.instalmentNumber === null || row.instalmentTotal === null || row.instalmentTotal < 2) {
      continue;
    }
    if (row.amountCents >= 0) {
      continue;
    }
    planRows.push({ row, number: row.instalmentNumber, total: row.instalmentTotal });
  }

  return planRows.sort(byLocalDateThenId);
}

function byLocalDateThenId(left: PlanRow, right: PlanRow): number {
  if (left.row.localDate !== right.row.localDate) {
    return left.row.localDate.localeCompare(right.row.localDate);
  }
  return left.row.id.localeCompare(right.row.id);
}

/**
 * Groups rows by the untruncated purchase instant.
 *
 * An instant covering two or more counters is strong evidence of one purchase; an instant covering
 * one row is no evidence either way, because some connectors stamp a posting date there.
 */
function bucketByInstant(candidates: readonly PlanRow[]): {
  readonly buckets: readonly PlanGroup[];
  readonly residual: readonly PlanRow[];
} {
  const grouped = new Map<string, PlanRow[]>();
  const residual: PlanRow[] = [];
  for (const candidate of candidates) {
    if (candidate.row.purchaseDate === null) {
      residual.push(candidate);
      continue;
    }
    const key = `${candidate.row.accountId}|${candidate.row.purchaseDate}|${candidate.total}`;
    const existing = grouped.get(key);
    if (existing === undefined) {
      grouped.set(key, [candidate]);
      continue;
    }
    existing.push(candidate);
  }

  const buckets: PlanGroup[] = [];
  for (const group of grouped.values()) {
    if (distinctCounters(group) >= 2) {
      buckets.push(asGroup(group));
      continue;
    }
    residual.push(...group);
  }

  return { buckets, residual: residual.sort(byLocalDateThenId) };
}

function distinctCounters(group: readonly PlanRow[]): number {
  return new Set(group.map(({ number }) => number)).size;
}

/** Narrows an array the caller already knows is non-empty. */
function asGroup(rows: readonly PlanRow[]): PlanGroup {
  const [head, ...tail] = rows;
  if (head === undefined) {
    // Stryker disable next-line all: unreachable, every caller filters empty groups first.
    throw new Error("An instalment plan group cannot be empty");
  }

  return [head, ...tail];
}

function buildPlan(group: PlanGroup): InstalmentPlan {
  const byNumber = positionsOf(group);
  const total = group[0].total;
  const anchor = highestPosition(byNumber);

  return {
    accountId: anchor.row.accountId,
    merchant: anchor.row.descriptionNorm,
    purchaseDate: null,
    purchaseTotalCents: null,
    purchaseTotalSource: null,
    instalmentAmountCents: Math.abs(anchor.row.amountCents),
    instalmentsPaid: 0,
    instalmentsTotal: total,
    instalmentsRemaining: total,
    remainingTotalCents: 0,
    remainingTotalSource: "estimated",
    finalCycle: null,
    finalCycleSource: "unknown",
    status: "open",
    renewal: false,
  };
}

/** One row per counter. A duplicated counter keeps the oldest row, which is the posted one. */
function positionsOf(group: PlanGroup): ReadonlyMap<number, PlanRow> {
  const byNumber = new Map<number, PlanRow>();
  for (const planRow of group) {
    if (!byNumber.has(planRow.number)) {
      byNumber.set(planRow.number, planRow);
    }
  }

  return byNumber;
}

function highestPosition(byNumber: ReadonlyMap<number, PlanRow>): PlanRow {
  let highest: PlanRow | null = null;
  for (const planRow of byNumber.values()) {
    if (highest === null || planRow.number > highest.number) {
      highest = planRow;
    }
  }

  return asGroup(highest === null ? [] : [highest])[0];
}
```

`highestPosition` routes its impossible case through `asGroup` so there is exactly one place that says "this cannot be empty". If that reads as too clever when you get there, inline the throw; do not add a second silent `?? fallback`.

**Step 4: Run it and watch it pass**

```bash
node --test tests/core/instalment-plans.test.ts
```

Expected: 5 passing.

**Step 5: Read the sensors**

`.sensors/cli.sh check .`, and resolve every failing row before committing.

**Step 6: Commit**

```bash
git add src/core/instalment-plans.ts tests/core/instalment-plans.test.ts
git commit -m "feat(core): group instalment rows by shared purchase instant"
```

---

## Task 2: Cycles, closed bills, and paid position

**Files:**
- Modify: `src/core/instalment-plans.ts`
- Modify: `tests/core/instalment-plans.test.ts`
- Create: `tests/fixtures/renamed-plan-card.ts`

Paid is a **position**, never a row count. The highest counter provably sitting on a closed bill is the paid position; everything above it is remaining. Counting rows instead invents debt the moment the cache does not reach back to the purchase.

A row's cycle comes from two sources only:

1. Its `billId` names a bill in the card's list, so the cycle is that bill's due month.
2. It carries no bill at all and is not forecast beyond the open cycle, so the cycle is the open cycle.

A row carrying a bill id we never fetched stops at rule 1. It does **not** fall through to rule 2: it demonstrably belongs to some bill, and assuming that bill is the open one would place an old row on the current cycle. Such a row neither counts as paid nor anchors a projection.

**`billForecastDate` is never read as an absolute month.** Its docblock at `src/core/transaction.ts:45` records why: one connector stamps a closed cycle onto purchases made after that cycle closed. Comparing it against the open cycle is the only sanctioned use, exactly as `belongsToFutureCycle` does in `bill-rows.ts`. That predicate is two lines and is reimplemented here rather than imported, because the design keeps this module independent of `bill-rows.ts` until ticket 03.

**Step 1: Build the Amazon fixture**

The design's regression case is concrete and it deserves the real shape, not a synthetic stand-in. Create `tests/fixtures/renamed-plan-card.ts`: twelve `-1_390` rows, counters 1 through 12, all sharing `purchaseDate: "2025-12-25T13:16:47.001Z"`, renamed from `AMAZON PRIME` to `AMAZON PRIME BR` at counter 7, with bills for counters 1 through 7, `billId: null` from 8 up, and `billForecastDate` running `2026-01` through `2026-12`. Row 8 is the anchor: unbilled, forecast `2026-08`, and it must place on the open cycle. Build it with `billFixture` and `derived`, following `tests/fixtures/bulk-posting-card.ts`.

The figures are already public in the design doc, so committing them is fine. **The repository is public: never commit a real statement.**

**Step 2: Write the failing test**

Append to `tests/core/instalment-plans.test.ts`, adding `import { bill } from "../fakes/bill-builder.ts";` and the fixture import:

```ts
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
```

The Amazon assertion stands alone rather than joining the table because its arrange step is a fixture, not a row list. That is the one shape that earns its own block.

**Step 3: Watch it fail**

```bash
node --test tests/core/instalment-plans.test.ts
```

Expected: the new cases fail on `paid` being `0` and `finalCycle` being `null`.

**Step 4: Implement**

```ts
/** What the position and cycle rules need, resolved once per card. */
type CycleContext = {
  readonly cycleByBillId: ReadonlyMap<string, string>;
  readonly closedBillIds: ReadonlySet<string>;
  readonly openCycle: string | null;
};

function cycleContext(input: InstalmentPlanInput): CycleContext {
  const cycleByBillId = new Map<string, string>();
  const closedBillIds = new Set<string>();
  for (const candidate of input.bills) {
    cycleByBillId.set(candidate.id, candidate.dueDate.slice(0, 7));
    if (billIsClosed(candidate, input.openCycle, input.today)) {
      closedBillIds.add(candidate.id);
    }
  }

  return { cycleByBillId, closedBillIds, openCycle: input.openCycle };
}

/**
 * A bill is closed when its cycle precedes the open one. Without an open cycle the closing date has
 * to answer, and a bill publishing neither counts as open, because the tool must never report a
 * smaller debt than the data supports.
 */
function billIsClosed(candidate: Bill, openCycle: string | null, today: string): boolean {
  if (openCycle !== null) {
    return candidate.dueDate.slice(0, 7) < openCycle;
  }

  return candidate.closingDate !== null && candidate.closingDate < today;
}

/** The cycle a row provably sits on, or null when nothing places it. */
function cycleOfRow(planRow: PlanRow, context: CycleContext): string | null {
  if (planRow.row.billId !== null) {
    return context.cycleByBillId.get(planRow.row.billId) ?? null;
  }
  if (context.openCycle === null || isFutureRow(planRow.row, context.openCycle)) {
    return null;
  }

  return context.openCycle;
}

/**
 * Mirrors `belongsToFutureCycle` in `bill-rows.ts`. Duplicated on purpose: this module stays
 * independent of that one until ticket 03 unifies the grouping, and ticket 03 owns the parity test.
 */
function isFutureRow(row: DerivedTransaction, openCycle: string): boolean {
  return row.billForecastDate === "0001-01"
    || (row.billForecastDate !== null && row.billForecastDate > openCycle);
}

function paidPosition(byNumber: ReadonlyMap<number, PlanRow>, context: CycleContext): number {
  let paid = 0;
  for (const [number, planRow] of byNumber) {
    if (planRow.row.billId !== null && context.closedBillIds.has(planRow.row.billId) && number > paid) {
      paid = number;
    }
  }

  return paid;
}

/** Advances a `YYYY-MM` cycle tag by whole months. */
function addMonths(cycle: string, months: number): string {
  const absolute = Number(cycle.slice(0, 4)) * 12 + (Number(cycle.slice(5, 7)) - 1) + months;
  const year = Math.trunc(absolute / 12);
  const month = (absolute % 12) + 1;

  return `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}`;
}

/** Projects from the highest-numbered instalment the data actually places on a cycle. */
function finalCycleOf(
  byNumber: ReadonlyMap<number, PlanRow>,
  total: number,
  context: CycleContext,
): { readonly finalCycle: string | null; readonly finalCycleSource: CycleSource } {
  let anchorNumber = 0;
  let anchorCycle: string | null = null;
  for (const [number, planRow] of byNumber) {
    const cycle = cycleOfRow(planRow, context);
    if (cycle !== null && number > anchorNumber) {
      anchorNumber = number;
      anchorCycle = cycle;
    }
  }
  if (anchorCycle === null) {
    return { finalCycle: null, finalCycleSource: "unknown" };
  }
  if (anchorNumber === total) {
    return { finalCycle: anchorCycle, finalCycleSource: "reported" };
  }

  return { finalCycle: addMonths(anchorCycle, total - anchorNumber), finalCycleSource: "derived" };
}
```

Thread `CycleContext` into `buildPlan(group, context)`, build it once in `deriveInstalmentPlans`, and replace the `instalmentsPaid`, `instalmentsRemaining`, `finalCycle` and `finalCycleSource` placeholders.

**Step 5: Watch it pass. Step 6: Read the sensors**

`.sensors/cli.sh check .`, and resolve every failing row before committing.

**Step 7: Commit**

```bash
git add src/core/instalment-plans.ts tests/core/instalment-plans.test.ts tests/fixtures/renamed-plan-card.ts
git commit -m "feat(core): derive paid position and final cycle from placed rows"
```

---

## Task 3: Money, summed where published and estimated only where not

**Files:**
- Modify: `src/core/instalment-plans.ts`
- Modify: `tests/core/instalment-plans.test.ts`

Both totals add the materialized rows at their real amounts and fill only the missing positions at the per-instalment amount. Multiplying a count by an amount throws away exact data the bank already sent, and the centavo drift makes the product wrong.

`purchaseTotalCents` is `null` when the lowest observed counter is above 1: those instalments were never cached and their amounts are not recoverable.

**Step 1: Write the failing test**

```ts
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
```

Loop with the same shape as the tables above, passing `bills: BILLS` and `openCycle: OPEN_CYCLE`, asserting one object.

Check the arithmetic before you implement, because a wrong expectation here ships wrong money. Case 1: paid is 1 (`closed-bill`), so remaining covers positions 2 and 3, published as 10 000 and 9 999. Case 2: nothing is billed, so paid is 0 and all ten positions cost 29 990, of which only the first two are published. Case 3: paid is 7, so five positions remain at 5 500, none of them published.

Case 2 carries two rows rather than one on purpose. A lone row stays residual until Task 4 teaches the derivation to segment, so a single-row case here would assert against an empty result and pass for the wrong reason.

**Step 2: Watch it fail. Step 3: Implement**

```ts
type Money = {
  readonly cents: number;
  readonly source: FigureSource;
};

/** Sums positions in `[from, to]`, using the published amount wherever there is one. */
function sumPositions(
  byNumber: ReadonlyMap<number, PlanRow>,
  from: number,
  to: number,
  instalmentAmountCents: number,
): Money {
  let cents = 0;
  let source: FigureSource = "reported";
  for (let position = from; position <= to; position += 1) {
    const planRow = byNumber.get(position);
    if (planRow === undefined) {
      cents += instalmentAmountCents;
      source = "estimated";
      continue;
    }
    cents += Math.abs(planRow.row.amountCents);
  }

  return { cents, source };
}
```

`remainingTotal` is `sumPositions(byNumber, paid + 1, total, instalmentAmountCents)`. `purchaseTotal` is `sumPositions(byNumber, 1, total, ...)` when the lowest observed counter is 1, and `{ cents: null, source: null }` otherwise.

**Step 4: Watch it pass. Step 5: Read the sensors**

`.sensors/cli.sh check .`, and resolve every failing row before committing.

**Step 6: Commit**

```bash
git commit -m "feat(core): sum published instalments and estimate only the missing ones"
```

---

## Task 4: Reconciliation, segmentation and renewals

**Files:**
- Modify: `src/core/instalment-plans.ts`
- Modify: `tests/core/instalment-plans.test.ts`
- Create: `tests/fixtures/annual-fee-card.ts`
- Create: `tests/fixtures/repeated-plan-card.ts`

Two rules for what the instant could not group, and one interpretation on top.

**Reconcile.** A residual row joins a bucket when they share account, normalized description and instalment count, the bucket has that counter free, and the bucket's highest counter is below the residual's. Among candidates the highest such counter wins, ties break on the latest `localDate`, and a remaining tie leaves the row alone and adds a note. Process residuals in ascending counter order so a chain can build. Match the description against **any** row in the bucket, because a plan can be renamed mid-flight.

**Segment.** What is still residual groups by account, normalized description and count, sorted by `localDate`, cutting a new plan whenever the counter fails to advance. `12` then `1` is a boundary. `1` then `1` is also a boundary.

**Renewal is an interpretation, not the boundary itself.** A segment is flagged `renewal: true` only when the preceding segment under the same key reached its own `N/N` and this one starts at 1. Two `1/10` rows are two purchases and neither is a renewal.

**Step 1: Build the two fixtures**

`tests/fixtures/annual-fee-card.ts`: twelve `-5_500` rows under one description, counters `6,7,8,9,10,11,12` then `1,2,3,4,5`, each carrying **its own** `purchaseDate` instant at midnight on its own `localDate`, monthly from `2025-08-08` to `2026-07-08`, each on a distinct bill id. This is the shape that proves segmentation, renewal and truncated history at once.

`tests/fixtures/repeated-plan-card.ts`: five complete `1/2 + 2/2` plans, each pair sharing its own instant, plus a sixth lone `1/2` at `-3_945` on `2026-07-25` with no bill. Six plans out, not five.

**Step 2: Write the failing test**

```ts
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
```

Then two fixture-driven assertions that the table cannot express:

```ts
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
```

The annual fee assertion is design cases 6 and 9 in one place, pinning settled status, the null purchase total, the null purchase date and the renewal flag together rather than across three tasks. `status` arrives in Task 6; until then this assertion fails on that key alone, which is the correct RED.

**Step 3: Watch it fail. Step 4: Implement. Step 5: Watch it pass.**

**Step 6: Read the sensors**

`.sensors/cli.sh check .`, and resolve every failing row before committing.

**Step 7: Commit**

```bash
git add src/core/instalment-plans.ts tests/core/instalment-plans.test.ts tests/fixtures/annual-fee-card.ts tests/fixtures/repeated-plan-card.ts
git commit -m "feat(core): reconcile straddling rows and segment restarted counters"
```

---

## Task 5: Reversals, as offsets against a position

**Files:**
- Modify: `src/core/instalment-plans.ts`
- Modify: `tests/core/instalment-plans.test.ts`
- Create: `tests/fixtures/reversed-instalment-card.ts`

Grouping already sees debits only, so a credit can never create, split or join a plan. Credits arrive now, as offsets against a position of a plan that already exists.

A credit offsets a materialized position when they share `accountId | descriptionNorm | instalmentTotal | instalmentNumber | abs(amountCents)` **and** fall on the same billing cycle. An offset position leaves paid, leaves remaining, and leaves both money totals. When every materialized position of a plan is offset the plan is `reversed` and excluded from `totals`; when only some are, the plan keeps its identity and its status, and the response carries an adjustment note.

Three constraints:

- **Offsets never form plans.** A credit matching no position is dropped with a note.
- **Same cycle.** Without it, a refund of an old purchase annuls a new one at the same merchant, same amount, same counter, months later.
- **One candidate.** Two debit positions against one credit is undefined: nothing is offset and a note names the rows.

The cache holds exactly one credit row carrying instalment metadata, so most of this is defensive. That is the point: `derivePostedCents` exists because a sign convention nobody checked cost real money once already.

**Step 1: Build the fixture**

`tests/fixtures/reversed-instalment-card.ts`, the real Araujo shape, whose figures are already public in the design doc:

| Row | Counter | Cents | Bill | Instant |
|---|---|---|---|---|
| debit | `1/2` | `-87_450` | `14cf4936` | `2026-05-28T14:32:34.000Z` |
| credit | `1/2` | `+87_450` | `14cf4936` | `2026-05-28T01:01:01.000Z` |
| debit | `1/3` | `-116_600` | `14cf4936` | `2026-05-28T14:49:31.000Z` |
| debit | `2/3` | `-116_600` | `48c42481` | `2026-05-28T14:49:31.000Z` |
| credit | none | `+174_900` | `48c42481` | none |

The last row is the backlog's trap 4: a `+1 749,00` refund of the same merchant on the same days, carrying no instalment metadata at all. It must change nothing. Include it, or the fixture proves less than the real feed demands.

Both rows of the offset pair sit on the same bill, which is what makes the same-cycle test pass on the only real case that exists. The `1/3` plan shares the merchant and the day with the reversed `1/2` and must survive untouched.

**Step 2: Write the failing test**

```ts
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
```

Then the partial-reversal case, which needs field-level assertions the status table cannot carry:

```ts
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
```

Work the expectation through before you implement it. Positions 1, 2 and 3 exist; position 2 is offset. Paid counts the highest position on a closed bill that is **not** offset, so paid is 1, not 2. Remaining covers position 3 alone, because 2 no longer exists for this plan, giving one instalment and 10 000. The purchase total sums positions 1 and 3, giving 20 000. Neither total may charge the refunded instalment twice, and neither may forget that the plan still owes position 3.

Plus the fixture assertion:

```ts
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
```

**Step 3: Watch it fail. Step 4: Implement. Step 5: Watch it pass.**

**Step 6: Read the sensors**

`.sensors/cli.sh check .`, and resolve every failing row before committing.

**Step 7: Commit**

```bash
git add src/core/instalment-plans.ts tests/core/instalment-plans.test.ts tests/fixtures/reversed-instalment-card.ts
git commit -m "feat(core): offset refunded instalments without eating live debt"
```

---

## Task 6: Presentation fields and ordering

**Files:**
- Modify: `src/core/instalment-plans.ts`
- Modify: `tests/core/instalment-plans.test.ts`

- `status` is `settled` when nothing remains, `reversed` when every position is offset, `open` otherwise.
- `purchaseDate` is the shared instant's day, and only when every row of the plan agrees on a non-null instant. A per-row posting date yields null: publishing a posting date under the name "purchase date" is false.
- `merchant` is the normalized description of the highest-numbered materialized row, ties on `localDate` then id.
- Order by `finalCycle` ascending with nulls last, then `remainingTotalCents` descending, then `accountId`, then `merchant`.

**Step 1: Write the failing test**

One table for the field rules, covering: a plan whose rows share an instant reports that day; a plan segmented on per-row posting dates reports null; a plan with nothing remaining reports `settled`; a renamed plan reports the later name.

Then one ordering test whose input order differs from the expected order on every key at once:

```ts
it("orders plans by final cycle, then by what is still owed", () => {
  const rows = [
    instalment({ id: "o1", number: 1, total: 2, cents: -1_000, purchaseDate: "O1", description: "ZULU" }),
    instalment({ id: "o2", number: 2, total: 2, cents: -1_000, purchaseDate: "O1", description: "ZULU" }),
    instalment({ id: "o3", number: 1, total: 2, cents: -9_000, purchaseDate: "O2", description: "ALPHA" }),
    instalment({ id: "o4", number: 2, total: 2, cents: -9_000, purchaseDate: "O2", description: "ALPHA" }),
  ];
  // ... plus one plan with a null finalCycle, which must sort last.
});
```

Build it so the plan with the null `finalCycle` sorts last, the larger `remainingTotalCents` precedes the smaller within one cycle, and the merchant tiebreak is exercised. A total order is what makes the tool's output diffable; a test that only checks the first key does not prove it.

**Step 2: Watch it fail. Step 3: Implement. Step 4: Watch it pass.**

**Step 5: Read the sensors**

`.sensors/cli.sh check .`, and resolve every failing row before committing.

**Step 6: Commit**

```bash
git commit -m "feat(core): finish plan presentation fields and total ordering"
```

---

## Task 7: The tool handler and its filters

**Files:**
- Create: `src/mcp/tools/instalment-plans.ts`
- Create: `tests/mcp/tools/instalment-plans.test.ts`

Mirror `src/mcp/tools/bills.ts`: a `*_DESCRIPTION` constant, a Zod schema, a `register*` wiring description and schema to a handler, and an exported `handle*` the tests call directly. This task delivers the handler, the filters and the per-card derivation. Formatting comes in Task 8, so the first version may return a deliberately thin payload.

The description follows the three-part template, because descriptions are the only discovery surface a model gets:

```ts
export const LIST_INSTALMENT_PLANS_DESCRIPTION = `Lists credit card purchases still being paid in instalments.

Use this tool when:
- The user asks what they are still paying off, or when a purchase finishes.
- You need committed future spending before judging whether a new purchase fits.
- You need to explain why a card's used credit exceeds its current bill.

Returns: One entry per plan with the merchant, what the purchase cost, the per-instalment amount, instalments paid and remaining, the money still owed, and the cycle the last instalment lands on. Each of those is marked reported when the bank published the underlying rows, and estimated or derived when it was projected from the instalments that did arrive; an estimate can be a centavo either side of the truth. A missing purchase total means the cache does not reach back to the first instalment. Cycles are the month a bill falls due. Open plans only unless includeSettled is set.`;
```

Schema, every field optional:

```ts
const listInstalmentPlansSchema = z.object({
  accountId: z.string().min(1).optional(),
  connectionId: z.string().min(1).optional(),
  includeSettled: z.boolean().default(false),
});
```

Handler flow:

1. Parse; on failure `finishToolError`.
2. Guard `deps.source.ok` and `deps.reader !== null`, exactly as `handleGetBillSummary` does.
3. `const loaded = await reader.load(connectionIds)`, where `connectionIds` is `source.connections` narrowed to `input.connectionId` when given. An unknown `connectionId` returns readable content, not a thrown error.
4. Keep `loaded.accounts` of `type === ACCOUNT_TYPES.credit`, narrowed to `input.accountId` when given. An `accountId` resolving to a non-credit account is a tool error, matching `resolveCreditAccount`.
5. For every card, **in parallel** with `Promise.all`: fetch `source.bank.getBills(account)`, read the stored closing day, call `identifyOpenCycle(bills, storedDay, balanceDueDate, today)`, read `reader.cardRows(account.id)`, and call `deriveInstalmentPlans`. One network call per card, so serializing them would make a three-card response three round trips deep.
6. Drop `settled` and `reversed` plans unless `includeSettled`.

**Tests.** Every tool parameter needs a test proving it reaches the request. The prior Go implementation shipped a declared filter that was parsed, validated and never read.

One table over `{ input, expectedAccountIds }` covering: no filter returns every card's plans; `accountId` restricts to one card; `connectionId` restricts to one connection's cards; an unknown `connectionId` returns readable content with a notice; a non-credit `accountId` returns a tool error. Plus one table over `{ includeSettled, expectedStatuses }` with two rows.

**Step 5: Read the sensors**

`.sensors/cli.sh check .`, and resolve every failing row before committing.

**Step 6: Commit**

```bash
git commit -m "feat(mcp): add the listInstalmentPlans handler and its filters"
```

---

## Task 8: Serialization, totals and notes

**Files:**
- Modify: `src/mcp/tools/instalment-plans.ts`
- Modify: `tests/mcp/tools/instalment-plans.test.ts`

Serialize with `textResult`, converting cents through `toDecimal` and spreading `formatSummaryBase(account)` alongside the card's `name`.

`totals` counts open plans only, renewals included, reversed excluded. `dataThrough` comes from `reader.dataThrough(accountIds, today)`, and `unavailable` from `loaded.unavailable`.

When `identifyOpenCycle` returns null, push the remedy note verbatim, prefixed with the card so a multi-card response stays readable:

```
`${account.name}: no closing day stored for this card; call setClosingDay to get final cycles`
```

The card's plans are still returned alongside that note. A card with an unidentifiable cycle is not a card with no instalments.

**`prune` deletes nulls, so an unknown figure is absent from the payload rather than present and null.** That is the repo's encoding and the description already explains it. Do not substitute a sentinel, and do not "fix" `prune`: a balance of exactly `0` must survive, which is why it strips only null and undefined.

**Tests:**

1. Money crosses the boundary as decimal strings.
2. A plan with an unknown purchase total has no `purchaseTotal` key at all, and a plan owing exactly `0` still carries `remainingTotal: "0.00"`.
3. A card with no identifiable open cycle produces the `setClosingDay` note **and** still returns its plans. Assert both in one test; a note without its plans is a different, wrong behaviour.
4. A reversed plan is absent from `totals.remaining` and from `totals.planCount` while being present in `plans` under `includeSettled`. This is the one assertion that pins the exclusion rule.
5. An unreachable connection returns readable content with a notice, never a protocol error.

**Step 5: Read the sensors**

`.sensors/cli.sh check .`, and resolve every failing row before committing.

**Step 6: Commit**

```bash
git commit -m "feat(mcp): serialize instalment plans with totals and notes"
```

---

## Task 9: Registration

**Files:**
- Modify: `src/mcp/server.ts:9-17,36-51`
- Modify: `tests/mcp/server.test.ts`

Add the import and append `registerListInstalmentPlans` to `REGISTRARS`. One list, so registering is not a place to forget one. `tests/mcp/server.test.ts` asserts the registered set; update it in the same commit or the suite goes red.

**Step 3: Read the sensors**

`.sensors/cli.sh check .`, and resolve every failing row before committing.

**Step 4: Commit**

```bash
git commit -m "feat(mcp): register listInstalmentPlans"
```

---

## Task 10: Full validation and mutation

**Step 1: Read the sensors one last time**

```bash
.sensors/cli.sh check .
```

Every row green except `cov` and `mut_state`, which are informational. `structure` is not a formality here: it is what proves `src/core/instalment-plans.ts` imports nothing from `src/pluggy/`, `src/storage/` or `src/mcp/`.

When the sidecar is not running, run the gates by hand instead, in CI's order:

```bash
source ~/.nvm/nvm.sh && nvm use
npm run typecheck && npm run lint && npm run deps && npm test && npm run build
```

**Step 2: Mutation**

`mutation` is a triggered runner rather than a scheduled one, so the `mut_state` row is the *last* result and may predate your changes. Force a fresh one:

```bash
npm run mutation
```

`src/core/` is in Stryker's scope, so the new module is covered. A green suite proves the tests ran, not that they assert. Read every survivor and either write the missing assertion or suppress it with a reason:

```ts
// Stryker disable next-line ArithmeticOperator: <why this mutant is not observable>
```

Pay attention to survivors in `addMonths`, `sumPositions` and `paidPosition`. Those are the three places where a surviving arithmetic or comparison mutant means the tests do not actually pin the money.

**Step 3: Commit**

```bash
git commit -m "test(core): close mutation survivors in the instalment derivation"
```

---

## Task 11: The acceptance fixture

**Files:**
- Create: `docs/research/2026-07-30-instalment-plans-acceptance.md`

The backlog appendix lists ten open plans totalling R$ 5 853,07. **Do not encode that number.** A probe against the live cache found it omits `MERCADOLIVRE*MERCADOL` `1/2` (R$ 39,45, posted 2026-07-25, so R$ 78,90 outstanding), omits the annual fee's R$ 385,00 that this design deliberately includes and flags, and reads `AMAZON PRIME BR` 12/12 as ending 2026-11 where the due-month convention says 2026-12. The cache has also moved: 1 741 rows through 2026-07-23 when the appendix was written, 1 754 through 2026-07-27 now.

So generate the oracle instead of copying it:

1. Freeze a snapshot of `~/.cache/cata-centavo/cache.db`.
2. Run the derivation over every card.
3. Review every plan by hand against the design's rules.
4. Write the result into `docs/research/`, together with the snapshot's row count and its `dataThrough`, so the next person can tell drift from regression.

**The bank app is the only oracle that confirms any of this.** Check one card against it before trusting the numbers, and record which card and when.

Two figures need care, because the probe could not settle them:

- The annual fee's R$ 385,00 assumes bill `48c42481` is closed. If it is the open bill, the honest answer is R$ 440,00 over eight instalments. Bills are not cached, so this cannot be settled from the snapshot alone; fetch them. Whichever way it lands, the derivation is right and the appendix is what needs correcting.
- `AMAZON PRIME BR` 8/12 carries a null `billId` and forecasts `2026-08`. It anchors the projection only when the open cycle is `2026-08` or later. Confirm the anchor the code actually picked rather than assuming it.

**The repository is public. Never commit a real statement.** The research note carries derived figures and merchant names already present in the design doc; it must not carry the snapshot.

---

## Definition of done

- [ ] `.sensors/cli.sh check .` is green on every row but `cov` and `mut_state`, and was green at the end of every step, not only this one.
- [ ] Without the sidecar: `npm run typecheck`, `npm run lint`, `npm run deps`, `npm test` and `npm run build` all pass, in that order, on Node 24.
- [ ] `listInstalmentPlans` is in `REGISTRARS` and `tests/mcp/server.test.ts` knows about it.
- [ ] All 21 numbered cases in the design's test list have an assertion that pins the whole behaviour, not a prose rule in a neighbouring task.
- [ ] `accountId`, `connectionId` and `includeSettled` each have a test proving they change the result.
- [ ] `npm run mutation` has been read; every survivor in the new module is killed or suppressed with a reason.
- [ ] `docs/research/2026-07-30-instalment-plans-acceptance.md` exists, names the card checked against the bank app, and records the snapshot it was generated from.
- [ ] `src/core/bill-rows.ts` is untouched. Unification is ticket 03.

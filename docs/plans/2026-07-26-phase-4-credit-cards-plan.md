# Phase 4 — credit cards Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Answer "qual minha fatura aberta?" with two measured figures whose gap reports the uncertainty, plus the closed statements and a local closing day, without ever returning a single number chosen by a hidden rule.

**Architecture:** One pure derivation in `src/core/bill.ts` computes both figures from every cached row of one card. `posted` sums the open cycle from the transaction feed; `committed` subtracts scheduled instalments from the bank's own used-limit figure. The term that defeated eight grouping keys — how much of an instalment plan is still to come — is computed without any plan key, by taking the larger of two independent measures that each count every plan exactly once under one of the two posting styles seen in the wallet.

**Tech Stack:** Node 24 native type stripping, `node:sqlite`, Zod at the MCP boundary, `node --test`, Stryker.

**Design document:** `docs/plans/2026-07-26-phase-4-credit-cards-design.md`. Read it before Task 1. Evidence: `docs/research/2026-07-26-phase-4-open-bill-derivation.md`. Where this plan and the design disagree, the design wins; where the design and the ADR disagree, this phase amends the ADR (Task 19).

---

## Before you start

```bash
nvm use          # v24.15.0. Node 18 makes `npm test` report "# tests 0" and exit 0
```

The check sequence, in this order, after every task:

```bash
npm run typecheck && npm run lint && npm run deps && npm test
```

`npm run mutation` is not in that sequence. It runs at Task 14 and again at Task 19.

No git worktree. `CLAUDE.md` forbids them unless the user asks.

**Phase 5 is landing in the same working tree and is not committed yet.** `Bank` has already gained `getConsent`, `Connection` has gained `failedLogins`, `FakeBankOptions` has gained `consents`, and `src/core/consent.ts` exists. Nothing here conflicts, but rebase onto whatever Phase 5 commits before starting, and re-read `src/core/contracts.ts` rather than trusting the line numbers below.

### The helpers that already exist — use these names, invent nothing

| where | what exists |
| --- | --- |
| `tests/fakes/transaction-builder.ts` | `tx(overrides)`, `derived(overrides)` |
| `tests/fakes/fake-bank.ts` | `fakeBank(options)`, `connection(id, o)`, `account(id, o)`, `threeConnections()` |
| `tests/fakes/fake-source.ts` | `fakeSource(options)`; `FakeSourceOptions` is a `Pick` of `FakeBankOptions` |
| `tests/fakes/fixed-clock.ts` | the injectable `Clock` every date rule needs |
| `tests/storage/transactions.test.ts` | `storeFor(log?)`, `storeAndDbFor(log?)`, `seededStore()`, `filterFor(ids)`, `idsOf(rows)` |
| `tests/pluggy/mapper.test.ts` | `wireRow(id)` — reads from `tests/fixtures/transactions-page.json` — and the module const `CARD_ACCOUNT` |

There is no `wireTransaction`, no `creditAccount`, no `storeWith`, no `transaction()`, and no card-metadata `describe` block. Card metadata is covered inside `EXTRACTION_CASES` in `describe("toTransaction")` at `tests/pluggy/mapper.test.ts:320`.

### Four facts that decide implementation details

1. **`billId` is absent, never null and never `""`.** Nested `creditCardMetadata` members are omitted when they have no value; top-level transaction fields are explicitly `null`. So `.optional()` on nested members and `.nullable()` at the top level — not interchangeable under `exactOptionalPropertyTypes`.
2. **A card whose open cycle appears in `/bills` stamps its open-cycle rows with that bill's id.** All three sandbox rows carry `billId = f93561c3`, the bill due 2026-08-15. "Unbilled" alone does not identify the open cycle, and Task 9 is where getting this wrong returns `posted: "0.00"` on a card holding 265,50.
3. **`/bills` honours both `pageSize` and `page`.** Measured 2026-07-26: `pageSize=5&page=2` returns a different window from `page=1` and `totalPages` recomputes from `pageSize`. The earlier capture only ever saw `totalPages: 1`, so this was re-measured specifically to justify copying the `/accounts` walk. `/v2/transactions` still rejects `pageSize` with a 400.
4. **`toCents` (`src/pluggy/money.ts`) rounds half-away-from-zero over the decimal representation.** Nubank sends four decimals (`307.8891`). Reuse it; never touch binary floats.

### One trap that fails silently

The transaction column list exists in **two** places: `TRANSACTION_COLUMNS` at `src/storage/transactions.ts:11-17`, and again inside `TRANSACTION_INSERT`'s `ON CONFLICT DO UPDATE SET` at `:26-48`. Add a column to the migration and the row codec but miss those, and the field never persists — the code compiles, fixture-backed tests pass, and only real data is wrong. Task 2's second test is the only thing that catches it.

---

## Task 1: Carry `billForecastDate` into the domain

**Files:**
- Modify: `src/pluggy/wire.ts` (`CREDIT_CARD_METADATA`), `src/core/transaction.ts`
- Modify: `src/pluggy/transaction-mapper.ts` — **three sites**: the `CardDetails` `Pick<>` at `:46-49`, the absent-metadata branch at `:86`, and `cardMetadataDetails` at `:92`
- Modify: `tests/fixtures/transactions-page.json` — the file `wireRow` reads from
- Test: `tests/pluggy/mapper.test.ts` — extend, do not create

**Step 1: Add the fixture rows**

`wireRow(id)` reads from `tests/fixtures/transactions-page.json`. Add three synthetic card rows to it: one with `creditCardMetadata.billForecastDate: "2026-08"`, one with `"0001-01"`, one with `creditCardMetadata` present and the key omitted. Synthetic amounts — the repo is public.

**Step 2: Write the failing table test**

Add to the existing `describe("toTransaction")`:

```ts
const FORECAST_CASES: readonly { readonly name: string; readonly id: string; readonly expected: string | null }[] = [
  { name: "carries a forecast cycle", id: "t-card-fc-cycle", expected: "2026-08" },
  { name: "carries the unassigned-cycle sentinel verbatim", id: "t-card-fc-sentinel", expected: "0001-01" },
  { name: "is null when the nested key is omitted", id: "t-card-fc-absent", expected: null },
];

for (const testCase of FORECAST_CASES) {
  it(testCase.name, () => {
    assert.equal(toTransaction(wireRow(testCase.id), CARD_ACCOUNT).billForecastDate, testCase.expected);
  });
}
```

**Step 3: Run and watch fail**

```bash
node --test tests/pluggy/mapper.test.ts
```

Expected: FAIL — `billForecastDate` is not a property of `Transaction`.

**Step 4: Implement**

`src/pluggy/wire.ts`, in `CREDIT_CARD_METADATA`:

```ts
  billForecastDate: z.string().optional(),
```

`src/core/transaction.ts`, beside `billId`:

```ts
  /**
   * The cycle Pluggy forecasts this row onto, `YYYY-MM`. Absent on most rows.
   * `"0001-01"` is a sentinel meaning "an instalment with no cycle assigned
   * yet", not a date. Unreliable as an absolute value — one connector stamps
   * the closed cycle onto purchases made after it closed — so it is only ever
   * compared against the open cycle, never read as the truth.
   */
  readonly billForecastDate: string | null;
```

`src/pluggy/transaction-mapper.ts`, all three sites: add `"billForecastDate"` to the `Pick<>` union, `billForecastDate: null` to the absent-metadata branch, and `billForecastDate: stringOrNull(metadata.billForecastDate)` to `cardMetadataDetails`.

**Step 5: Verify** · **Step 6: Commit**

```bash
npm run typecheck && npm run lint && npm run deps && npm test
git add src/pluggy src/core/transaction.ts tests/pluggy tests/fixtures
git commit -m "feat: carry billForecastDate from Pluggy into the domain"
```

---

## Task 2: Persist `bill_forecast_date`

**Files:**
- Modify: `src/storage/migrations.ts` (`CACHE_MIGRATIONS`), `src/storage/transaction-row.ts`, `src/storage/transactions.ts:11-17` and `:26-48`
- Test: `tests/storage/transactions.test.ts`

**Step 1: Extend the existing round-trip, then add the one test that is genuinely new**

`tests/storage/transactions.test.ts:107` already `deepEqual`s a stored row against its input, so the SELECT half comes free once `billForecastDate` joins `Transaction` — just add it to that test's `tx({...})`. The `ON CONFLICT DO UPDATE SET` half is what fails silently, and nothing covers it:

```ts
it("re-reads bill_forecast_date after an upsert of the same id", () => {
  const store = storeFor();
  store.replaceAccount("acc-1", "conn-1", [tx({ id: "t-1", billForecastDate: null })], null);
  store.replaceAccount("acc-1", "conn-1", [tx({ id: "t-1", billForecastDate: "2026-09" })], null);

  assert.equal(store.query(filterFor(["acc-1"]))[0]?.billForecastDate, "2026-09");
});
```

No new test file. No version assertion to update: `tests/storage/db.test.ts:164,176` assert via `targetVersion(CACHE_MIGRATIONS)`, which self-updates and cannot catch a wrong `to:`. `tests/storage/migrations.test.ts` asserts the MCC seed and the *data* table list; neither moves here.

**Step 2: Run and watch fail** — the upsert test returns `null`.

**Step 3: Implement**

A separate entry, never an edit to entry 1, because rebuild replays the whole list against a dropped file:

```ts
  {
    to: 3,
    up: `
      ALTER TABLE transactions ADD COLUMN bill_forecast_date TEXT;
    `,
  },
```

Then `transactionValues` and `rowToDerived` in `transaction-row.ts`, and **both** lists in `transactions.ts`.

**Step 4: Verify** · **Step 5: Commit**

```bash
git commit -m "feat: persist bill_forecast_date, bumping the cache to 3"
```

---

## Task 3: Share the self-transfer exclusion

Two copies of "what is not spending" is how two totals for one question happen.

**Files:** create `src/core/self-transfer.ts`; modify `src/core/aggregate.ts`; `tests/core/aggregate.test.ts` must stay green **untouched**.

Cut `SELF_TRANSFER_LEAVES`, `SELF_TRANSFER_GROUP` and `isSelfTransfer` verbatim into the new file, keeping the docblock. **Export `isSelfTransfer` only** — leaving the two constants module-private is the point, because an exported set gives Task 10 a second way to duplicate the definition. Import it back in `aggregate.ts` and delete the originals outright; this is a feature branch, no re-export shim.

If `tests/core/aggregate.test.ts` needed editing, the move was not a move.

```bash
npm run typecheck && npm run lint && npm run deps && npm test
git commit -m "refactor: share the self-transfer exclusion between aggregate and bill"
```

---

## Task 4: The `Bill` domain type and its mapper

**Files:** create `src/core/bill.ts` (type only); modify `src/pluggy/wire.ts`, `src/pluggy/mapper.ts`; test `tests/pluggy/mapper.test.ts`

**Step 1: Write the failing table test**

```ts
const BILL_CASES: readonly {
  readonly name: string;
  readonly wire: Record<string, unknown>;
  readonly expected: Partial<Bill>;
}[] = [
  {
    name: "sums finance charges and payments rather than passing the arrays",
    wire: { financeCharges: [{ amount: 1.5 }, { amount: 2.25 }], payments: [{ amount: 10 }, { amount: 5 }] },
    expected: { financeChargesCents: 375, paymentsCents: 1_500, paymentCount: 2 },
  },
  { name: "rounds four decimals half away from zero", wire: { totalAmount: 307.8891 }, expected: { totalCents: 30_789 } },
  { name: "keeps a null closing date rather than inventing one", wire: { billClosingDate: null }, expected: { closingDate: null } },
  { name: "reduces a UTC midnight to its calendar day", wire: { dueDate: "2026-08-15T00:00:00.000Z" }, expected: { dueDate: "2026-08-15" } },
  { name: "reduces the sandbox connector's 03:00Z to the same day", wire: { dueDate: "2026-08-15T03:00:00.000Z" }, expected: { dueDate: "2026-08-15" } },
  { name: "falls back to the account currency when the bill omits one", wire: { totalAmountCurrencyCode: null }, expected: { currency: "BRL" } },
];
```

Write a local `wireBill(overrides)` helper in the test file over a complete default, so each case states only what it varies.

The last two cases are the load-bearing ones. `dueDate` is a `YYYY-MM-DD` string taken from the **UTC parts**; a `new Date(...)` compared in local time puts a bill due on the 1st into the previous month. And `Bill.currency` is non-nullable while the wire field is `.nullish()`, so the fallback has to be stated — it is the account's currency, never `""` (CLAUDE.md forbids empty-string-as-absence).

**Step 2: Fail** · **Step 3: Implement**

```ts
/**
 * A credit card statement as we speak of it. Money in integer cents; dates as
 * `YYYY-MM-DD` taken from the payload's UTC parts, because the connectors send
 * a calendar date wearing a time — `00:00:00.000Z` on the real one and
 * `03:00:00.000Z` on the sandbox — and in UTC−3 the second parses to the
 * previous day (ADR §14.3).
 *
 * Charges and payments are summed at the boundary rather than passed through.
 * ADR §16.2 records an unbounded nested array dominating a response; these are
 * the same shape.
 */
export type Bill = {
  readonly id: string;
  readonly closingDate: string | null;
  readonly dueDate: string;
  readonly totalCents: number;
  readonly currency: string;
  readonly minimumPaymentCents: number | null;
  readonly financeChargesCents: number;
  readonly paymentsCents: number;
  readonly paymentCount: number;
};
```

`BILL` in `wire.ts` mirrors the observed body; `BILL_PAGE` is the `{total, totalPages, page, results}` envelope.

**Step 4: Verify** · **Step 5: Commit**

```bash
git commit -m "feat: add the Bill domain type and its Pluggy mapping"
```

---

## Task 5: `Bank.getBills`

**Files:** modify `src/core/contracts.ts`, `src/pluggy/client.ts`, `tests/fakes/fake-bank.ts`, `tests/fakes/fake-source.ts`; test `tests/pluggy/client.test.ts`

**Step 1: Write the failing tests**

```ts
const BILLS_WALK_CASES: readonly { readonly name: string; readonly totalPages: number; readonly perPage: number; readonly expected: number }[] = [
  { name: "walks every page to totalPages", totalPages: 3, perPage: 5, expected: 12 },
  { name: "returns an empty list without error when the bank publishes none", totalPages: 1, perPage: 0, expected: 0 },
];
```

Plus two separate assertions:

```ts
it("returns each bill once across a multi-page walk", () => {
  // The /accounts walk has no seenIds guard, unlike createTransactionWalker
  // (client.ts:26-28). Assert distinct ids, so a connector that silently
  // ignored `page=` would fail here rather than double every bill.
});

it("orders newest first, putting a null closing date last", () => {
  // Sort on closingDate descending, dueDate as tiebreak, nulls last. The
  // sandbox connector returns closingDate: null on every bill, so null
  // ordering is not hypothetical. Do not trust /bills' observed order.
});
```

**Step 2: Fail** · **Step 3: Implement**

The walk copies `/accounts` at `client.ts:88-98` — first page, then `Promise.all` over `totalPages - 1`, `pageSize=500`. Both parameters are honoured (fact 3).

Add the method to `Bank` with a docblock — the sixth, now that Phase 5's `getConsent` has landed. Then **both fakes**:
- `fakeBank`: a `bills?: Readonly<Record<string, readonly Bill[]>>` option defaulting to `[]`, so the ten test files using it keep compiling
- `fake-source.ts:13`: add `"bills"` to the `FakeSourceOptions` `Pick` and forward it — Tasks 17 and 18 both need it, and it is a one-word change that is easy to discover three tasks late

**Step 4: Verify** · **Step 5: Commit**

```bash
git commit -m "feat: read credit card bills from Pluggy"
```

---

## Task 6: `cardRows`, on the store *and* the reader

The derivation needs rows no range filter can express: future-dated instalments, the `0001-01` sentinel row, and closed-cycle history for the wrap-around guard.

**Files:**
- Modify: `src/core/contracts.ts` (`TransactionStore`), `src/core/transactions.ts` (`TransactionReader` **and** `createTransactionReader`), `src/storage/transactions.ts`
- Modify: three object literals typed as one of the two contracts, none of which compile until the new member is added — `tests/mcp/tools/transactions.test.ts:32` (`TransactionStore`), `tests/mcp/tools/transactions.test.ts:99` (`TransactionReader`), `tests/mcp/tools/transaction-details.test.ts:14` (`TransactionReader`)
- Test: `tests/storage/transactions.test.ts`

**`.dependency-cruiser.js` rule `only-bin-builds-infrastructure` forbids `src/mcp/` importing `src/storage/`.** `ToolDeps.reader` is a `TransactionReader` (`mcp/tools/result.ts:12`), and that type currently exposes only `load / query / byIds / dataThrough`. Adding `cardRows` to `TransactionStore` alone leaves Task 18 with no way to reach it. Both interfaces, in this task.

**Step 1: Write the failing test**

```ts
it("returns rows outside any date window, ordered oldest first", () => {
  const store = storeFor();
  store.replaceAccount("card-1", "conn-1", [
    tx({ id: "future", accountId: "card-1", localDate: "2026-11-25" }),
    tx({ id: "past", accountId: "card-1", localDate: "2025-07-31" }),
  ], null);
  store.replaceAccount("card-2", "conn-1", [tx({ id: "other", accountId: "card-2" })], null);

  assert.deepEqual(idsOf(store.cardRows("card-1")), ["past", "future"]);
});
```

Order is asserted, not sorted away: Task 13's wrap-around guard reads "a row of the same description with an **earlier** `localDate`", so `ORDER BY local_date, id` is part of the contract rather than an accident.

**Step 2: Fail** · **Step 3: Implement**

Reuse `DERIVED_CATEGORY` / `DERIVED_COLUMNS` from `category-sql.ts` so `cardRows` returns `DerivedTransaction` with the same resolution `query` uses — Task 10 needs `isSelfTransfer`, which reads the resolved category.

**Step 4: Verify** · **Step 5: Commit**

```bash
git commit -m "feat: read every cached row for one card, unbounded by date"
```

---

## Task 7: The bill test fixtures and builders

Written before the derivation so Tasks 8–13 have one arrangement rather than four copy-pasted ones.

**Files:** create `tests/fakes/bill-builder.ts`; modify `tests/fixtures/` with three synthetic card shapes

**Amounts are synthetic.** The repo is public and CLAUDE.md forbids committing real statements. The three real figures — 6.042,44 / 42,92 / 265,50 — belong in Task 19's live acceptance record, not in a fixture. What the fixtures reproduce is the **shape** of each card, at amounts chosen to make the arithmetic legible:

| fixture | reproduces | shape |
| --- | --- | --- |
| `materializing-card` | the gold | one plan whose remaining instalments exist as future-forecast rows; counter embedded in the description; a rename mid-plan |
| `one-per-bill-card` | the Santander | one running plan present as a single open-cycle row; one wrap-around subscription; one sentinel-forecast row |
| `open-bill-in-list-card` | the sandbox | open cycle present in `/bills`, its rows carrying that bill's id |
| `bulk-posting-card` | ADR §14.3's 45× case | five rows of one 10× plan in a single cycle |

`bill-builder.ts` exports `bill(overrides)` beside the existing `tx()` style, and:

```ts
/** One card's whole world: account, bills, rows, stored closing day, clock. */
export function billFixture(overrides?: Partial<BillFixture>): BillFixture;
```

Use the existing `tests/fakes/fixed-clock.ts` for the clock and `account(id, o)` from `fake-bank.ts` for the account. A `CreditDetails` override must supply all five members (`src/core/account.ts:35-41`) — give `billFixture` a complete credit default so cases vary one field.

```bash
git commit -m "test: add the bill fixtures and the shared card arrangement"
```

---

## Task 8: Identify the open cycle

**Files:** modify `src/core/bill.ts`; test `tests/core/bill.test.ts` (create — a genuinely new unit)

**Step 1: Write the failing table test**

`ClosingDateSource` is a `const` object plus a derived union — **no `enum`**, `erasableSyntaxOnly` rejects it. See `src/cli/dispatch.ts` for the pattern.

Every case supplies every member; `billFixture` provides the defaults so cases stay short.

```ts
const CYCLE_CASES: readonly {
  readonly name: string;
  readonly fixture: BillFixture;
  readonly expected: { readonly openCycle: string; readonly source: ClosingDateSource } | null;
}[] = [
  {
    name: "a bill whose closing day has not passed is itself the open cycle",
    fixture: billFixture({ bills: [bill({ closingDate: "2026-08-08", dueDate: "2026-08-15" })], today: "2026-07-26" }),
    expected: { openCycle: "2026-08", source: "open-bill" },
  },
  {
    name: "otherwise the open cycle is the month after the newest closed bill",
    fixture: billFixture({ bills: [bill({ closingDate: "2026-07-08", dueDate: "2026-07-15" })], today: "2026-07-26" }),
    expected: { openCycle: "2026-08", source: "last-closed" },
  },
  {
    name: "a bill closing exactly today is still closing, not closed",
    fixture: billFixture({ bills: [bill({ closingDate: "2026-07-26", dueDate: "2026-08-02" })], today: "2026-07-26" }),
    expected: { openCycle: "2026-08", source: "open-bill" },
  },
  {
    name: "December rolls the year over",
    fixture: billFixture({ bills: [bill({ closingDate: "2026-12-08", dueDate: "2026-12-15" })], today: "2027-01-05" }),
    expected: { openCycle: "2027-01", source: "last-closed" },
  },
  {
    name: "with no bills the stored day wins over balanceDueDate",
    fixture: billFixture({ bills: [], storedDay: 20, balanceDueDate: "2026-07-15", today: "2026-07-26" }),
    expected: { openCycle: "2026-08", source: "local" },
  },
  {
    name: "a stored day of 31 clamps to the last day of February, so the 28th still closes",
    fixture: billFixture({ bills: [], storedDay: 31, today: "2027-02-28" }),
    expected: { openCycle: "2027-03", source: "local" },
  },
  {
    name: "and the 27th does not",
    fixture: billFixture({ bills: [], storedDay: 31, today: "2027-02-27" }),
    expected: { openCycle: "2027-02", source: "local" },
  },
  {
    name: "with no bills and no stored day, balanceDueDate answers",
    fixture: billFixture({ bills: [], storedDay: null, balanceDueDate: "2026-07-15" }),
    expected: { openCycle: "2026-08", source: "due-date" },
  },
  {
    name: "with none of the four the cycle is not identifiable",
    fixture: billFixture({ bills: [], storedDay: null, balanceDueDate: null }),
    expected: null,
  },
];
```

The February pair is deliberately a pair. A single case at `today: "2027-02-10"` passes with the clamp, without it, and for any stored day ≥ 11 — it asserts nothing, and Task 14's mutation run would report exactly that survivor.

**Do not write a case that compares an instant.** The rule is two steps: reduce the bill's timestamp to `YYYY-MM-DD` from its UTC parts (Task 4 already did), then compare that string against `todayIn(clock)` from `core/date.ts:27`, which is `America/Sao_Paulo`. A case using `new Date()` passes in CI and flips the cycle a day early for three hours every São Paulo evening.

**Step 2: Fail** · **Step 3: Implement** · **Step 4: Verify** · **Step 5: Commit**

```bash
git commit -m "feat: identify the open billing cycle from four sources"
```

---

## Task 9: Which rows belong to the open cycle

The task where a wrong answer returns zero on a real card. Read design §"Which rows belong to the open cycle" first.

**Files:** `src/core/bill.ts`, `tests/core/bill.test.ts`

**Step 1: Write the failing table test**

Annotate the array so the heterogeneous cases compile; every case supplies `openBillId`, which is `null` on the two real cards.

```ts
const MEMBERSHIP_CASES: readonly {
  readonly name: string;
  readonly openBillId: string | null;
  readonly row: DerivedTransaction;
  readonly expected: "open" | "future" | "neither";
}[] = [
  { name: "a row carrying the open bill's own id is in the open cycle",
    openBillId: "open-bill", row: derived({ billId: "open-bill", billForecastDate: null }), expected: "open" },
  { name: "a row carrying a closed bill's id is in neither bucket",
    openBillId: "open-bill", row: derived({ billId: "closed-bill" }), expected: "neither" },
  { name: "with no open bill in the list, any billed row is in neither bucket",
    openBillId: null, row: derived({ billId: "closed-bill" }), expected: "neither" },
  { name: "an unbilled row forecast to the open cycle is in the open cycle",
    openBillId: null, row: derived({ billId: null, billForecastDate: "2026-08" }), expected: "open" },
  { name: "an unbilled row forecast to a past cycle is still in the open cycle",
    openBillId: null, row: derived({ billId: null, billForecastDate: "2026-07" }), expected: "open" },
  { name: "an unbilled row forecast beyond the open cycle is future",
    openBillId: null, row: derived({ billId: null, billForecastDate: "2026-09" }), expected: "future" },
  { name: "the unassigned-cycle sentinel is future, not January of year one",
    openBillId: null, row: derived({ billId: null, billForecastDate: "0001-01" }), expected: "future" },
  { name: "an unbilled row with no forecast at all falls to the open cycle",
    openBillId: null, row: derived({ billId: null, billForecastDate: null }), expected: "open" },
];
```

Cases 3–8 are the production path of both real cards — neither has an open bill in `/bills`. Case 5 encodes the Santander's mis-stamping: it writes `2026-07` on purchases made after the July cycle closed, so "past" must mean open, not dropped. Case 8 is the branch the capture never produced; the design explains why it resolves to open.

**Step 2–5:** fail, implement, verify, commit.

```bash
git commit -m "feat: partition a card's rows into the open cycle and later ones"
```

---

## Task 10: `posted`

**Files:** `src/core/bill.ts`, `tests/core/bill.test.ts`

**Step 1: Write the failing table test**

One arrange-act-assert — rows in, `posted` out — so it is one table, not four `it()` blocks:

```ts
const POSTED_CASES: readonly {
  readonly name: string;
  readonly rows: readonly DerivedTransaction[];
  readonly postedCents: number;
}[] = [
  { name: "a purchase increases the bill despite arriving negative", ... },
  { name: "excludes the card bill payment regardless of the bank's wording", ... },  // 05100000, both banks
  { name: "keeps a refund inside the bill", ... },                                    // 12000000, not a transfer leaf
  { name: "excludes every self-transfer leaf, not just the card payment", ... },      // the set is five, not one
  { name: "an empty open cycle posts zero rather than failing", ... },
];
```

Assert on `categoryId`, never on the description: the payment reads `PAGAMENTO DE FATURA` on one card and `Pagamento recebido` on the other.

**Sign is the trap.** `Transaction.amountCents` on `CREDIT` is already negated (`transaction-mapper.ts:22-31`), so a purchase is negative, while `account.amountCents` is a positive used limit. Convert once, at the top of the derivation, into bill sign. A case that passes a positive `amountCents` for a purchase is testing the wrong thing.

**Step 2–5:** fail, implement, verify, commit.

```bash
git commit -m "feat: sum what has posted to the open cycle"
```

---

## Task 11: `future` from the two measures, and `committed`

Split from the next two tasks deliberately: `max` is one mechanism, the dedupe is another, the wrap guard is a third, and bundling them is how a survivor hides.

**Files:** `src/core/bill.ts`, `tests/core/bill.test.ts`

**Step 1: Write the failing table test**

```ts
const FUTURE_CASES: readonly {
  readonly name: string;
  readonly rows: readonly DerivedTransaction[];
  readonly materializedCents: number;
  readonly impliedCents: number;
  readonly futureCents: number;
}[] = [
  { name: "a fully materialized plan is counted from its future rows", ... },
  { name: "a one-per-bill plan is counted from the open-cycle row's own position", ... },
  { name: "a plan that is both materialized and open-cycle is counted once, not twice", ... },
  { name: "a card with no instalments at all has no future", ... },
];
```

Case 3 is the `max`: the one-per-bill fixture's sentinel row and its open-cycle `1/2` describe the same plan, and summing them double-counts.

Then, separately, because the assertion target differs:

```ts
it("reports a negative committed rather than clamping it to zero", () => {
  // A card paid down while materialized instalments remain. A visibly wrong
  // number is recoverable; a zero is indistinguishable from a real answer.
});
```

**Step 2: Fail** · **Step 3: Implement**

```ts
const future = Math.max(materializedCents, impliedCents);
const committedCents = utilizationCents - future;
```

**Step 4: Verify** · **Step 5: Commit**

```bash
git commit -m "feat: derive committed instalments without a plan key"
```

---

## Task 12: Dedupe within the open cycle

ADR §14.3's 45× bug, arriving through the door `max` leaves open when a materialized plan is not stamped with a future forecast.

**Files:** `src/core/bill.ts`, `tests/core/bill.test.ts`

**Step 1: Write the failing test**

Against the `bulk-posting-card` fixture:

```ts
it("counts a plan posted as five rows in one cycle once, not five times", () => {
  // Five rows of a 10x plan at once must imply 9 instalments, never 9+8+7+6+5.
  // Without the dedupe this over-states `future` by 25 instalments and drives
  // `committed` well below the real bill.
});
```

**Step 2: Fail** · **Step 3: Implement**

Before summing `implied`, group open-cycle instalment rows by `description | instalmentTotal` and keep the highest `instalmentNumber`. Use the **domain** field names — `instalmentTotal` / `instalmentNumber` (`core/transaction.ts:45-46`), not Pluggy's spelling — this is a `core/` file.

The docblock states why grouping is safe here and nowhere else: a wrap-around needs two cycles, and the gold's counter-in-description differs per instalment, so within a single cycle both pathologies collapse correctly. The eight-key sweep in the research document is about grouping *across* cycles.

**Step 4: Verify** · **Step 5: Commit**

```bash
git commit -m "feat: count a plan posted several rows at once only once"
```

---

## Task 13: The wrap-around subscription guard

**Files:** `src/core/bill.ts`, `tests/core/bill.test.ts`

**Step 1: Write the failing tests**

```ts
it("treats a wrap-around subscription as no commitment at all", () => {
  // 6/12..12/12 then 1/12..5/12 under one description. An earlier row already
  // reached 12/12, so the counter has wrapped and the remainder is zero.
  // Without this the one-per-bill card gains a phantom commitment the moment
  // its annual fee posts unbilled next cycle.
});

it("reads the raw description, not the normalized one", () => {
  // normalizeDescription (core/description.ts) strips the trailing n/m — the
  // very thing this guard has to see. Feeding it here collapses the
  // materializing card's 8/12 and 12/12 into one key, fires the guard on a
  // real plan, and zeroes a genuine remainder.
});
```

The second test is the one that matters: it fails only if the implementation reaches for the existing normalizer, which is the natural thing to do.

**Step 2: Fail** · **Step 3: Implement**

If any row of the same **raw** `description` with an earlier `localDate` already reached `instalmentNumber === instalmentTotal`, the remainder is zero. `cardRows` returns rows ordered oldest first (Task 6), so "earlier" is available without re-sorting.

Record the designed-in false positive in the docblock: two separate instalment purchases with an identical description, the first completed, zero out the second's real remainder.

**Step 4: Verify** · **Step 5: Commit**

```bash
git commit -m "feat: treat a wrap-around subscription as no commitment"
```

---

## Task 14: Mutation checkpoint

`core/bill.ts` is complete and Stryker's scope is `src/core + src/pluggy`, so nothing in Tasks 15–18 contributes. Run it here, where the survivors are cheap to fix:

```bash
npm run mutation
```

Expect survivors on `max`, on the within-cycle dedupe, and on the wrap-around guard. Those three are where a green suite proves least. Either write the missing assertion or suppress with a reason (`// Stryker disable next-line <Mutator>: why`).

```bash
git commit -m "test: close the mutation survivors in the bill derivation"
```

---

## Task 15: The closing-day store

**Files:** modify `src/storage/migrations.ts` (`DATA_MIGRATIONS`), `src/core/contracts.ts`; create `src/storage/closing-days.ts`; test `tests/storage/closing-days.test.ts` (create — a genuinely new unit), and **modify `tests/storage/migrations.test.ts:31`**, whose `deepEqual` pins the exact data-table list and fails the moment a fourth table lands.

**Step 1: Write the failing tests** against `:memory:` with the two-file `ATTACH` form the other storage tests use: insert, upsert over the same `accountId`, list, delete, and delete of an absent id returning zero rather than throwing.

**Step 2–3: Implement**

```ts
  {
    to: 2,
    up: `
      CREATE TABLE card_closing_day (
        account_id TEXT PRIMARY KEY,
        day INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
```

Bare `CREATE TABLE` only. `db.ts:81` rewrites `CREATE TABLE ` to `CREATE TABLE userdata.` for the in-memory form; an index or `ALTER` in the same entry breaks every storage test. `data.db` is never dropped, so unlike Task 2 this is a real incremental migration against existing files.

**Step 4–5:** verify, commit.

```bash
git commit -m "feat: store a per-card closing day in data.db"
```

---

## Task 16: The three closing-day tools

**Files:** create `src/mcp/tools/closing-days.ts`; modify `src/mcp/tools/result.ts:9-15` (`ToolDeps`), `src/mcp/source.ts`, `src/mcp/server.ts`, `src/bin/cata-centavo.ts`; test `tests/mcp/tools/closing-days.test.ts` (create)

Wire the dependency **first**. `.dependency-cruiser.js` forbids `src/mcp/` importing `src/storage/`, so the store arrives through `ToolDeps`, constructed in `src/bin/`. Writing the import and finding out at `npm run deps` is the predictable way to lose ten minutes.

**Step 1: Write the failing tests** — one table over the three verbs asserting each parameter reaches the store. The PRD's rule 3 exists because the prior implementation shipped a filter that was parsed, validated and never read. Plus Zod rejection of `day: 0`, `day: 32`, and a non-integer.

**Step 2–5:** fail, implement, verify, commit.

```bash
git commit -m "feat: list, set and delete a card's closing day"
```

---

## Task 17: `getBills`

**Files:** create `src/mcp/tools/bills.ts`; modify `src/mcp/server.ts`; test `tests/mcp/tools/bills.test.ts` (create)

Description verbatim from the design — including "on some banks the newest entry is the cycle still in progress", which is true on the sandbox card and which an earlier draft of the design got backwards.

Tests: an empty list is a normal result and not `isError`; `limit` reaches the response and defaults to 12; money is a decimal string; an unknown `accountId` is readable `isError` content, not a protocol error.

```bash
git commit -m "feat: expose credit card statements over MCP"
```

---

## Task 18: `getBillSummary`

**Files:** modify `src/mcp/tools/bills.ts`, `src/mcp/server.ts`; test `tests/mcp/tools/bills.test.ts`

**Money crosses as decimal strings via `toDecimal`.** Every existing tool does (`tools/accounts.ts:126`, `tools/balance.ts:106`, `tools/transactions.ts:221`). Emitting `utilizationCents: 917089` beside `getAccounts`' `usedCredit: "9170.89"` hands the model two units for one quantity. Cents stay inside `core/bill.ts`.

**Call `reader.load([connectionId])` before reading rows.** `cardRows` reads the cache and nothing else; without the read-through walk a first call on a cold cache takes the never-synced branch every time.

**Step 1: Write the failing tests**

The error table is the test table, and each case needs a body:

```ts
const FAILURE_CASES: readonly {
  readonly name: string;
  readonly fixture: BillFixture;
  readonly isError: boolean;
  readonly mentions: string;
  readonly omits: readonly string[];
}[] = [
  { name: "a checking account is refused by type and names the type it found",
    isError: true, mentions: "CHECKING_ACCOUNT", omits: ["posted", "committed"] },
  { name: "an unknown accountId is readable content, not a protocol error",
    isError: true, mentions: "not found", omits: ["posted", "committed"] },
  { name: "a card with no cached rows returns utilization and omits the derived figures",
    isError: false, mentions: "never been synced", omits: ["posted", "committed", "topTransactions"] },
  { name: "no bills, no stored day and no balanceDueDate asks for setClosingDay",
    isError: false, mentions: "setClosingDay", omits: ["posted", "committed"] },
  { name: "a revoked consent is readable content",
    isError: true, mentions: "consent", omits: ["posted", "committed"] },
];
```

Plus, separately:

```ts
it("never returns a figure without the date its data stops at", () => {
  // Assert on the SERIALIZED payload, not the object: prune (format.ts:15)
  // drops nulls, so a missing dataThrough vanishes silently while posted and
  // committed still look like measurements.
});

it("returns at most five top transactions, purchases only, in bill sign", () => {
  // Positive, so they read alongside posted rather than against it.
});
```

A transport failure staying a protocol error is asserted in whichever test file already covers that convention for the other tools — do not duplicate the harness here.

**Step 2–5:** fail, implement, verify, commit.

```bash
git commit -m "feat: report the open bill as two measured figures"
```

---

## Task 19: Live acceptance and the amendments

**Step 1: Re-run mutation.** Tasks 15–18 are outside Stryker's scope, but Task 14's suppressions may have drifted.

**Step 2: Live acceptance.** Run the real server against the real wallet and record totals and counts — never statements or ids — in `docs/research/2026-07-26-phase-4-acceptance.md`. This is where the three real figures belong, and the only place they may appear:

- gold: `committed` is 42,92, `posted` is 23,90, `staleDays` reports the eighteen-day lag
- Santander: `posted` is 6.046,52, `committed` is 6.409,34
- sandbox: `posted` is 265,50 and **not zero** — the Task 9 regression
- an empty bill list reads as normal

If a figure has moved since 2026-07-26, record the new one and the delta rather than editing the target. The cards keep transacting.

**Step 3: Amend the ADR and the PRD.**

- ADR §14.3: `manageClosingDate` is three verbs; the open-bill signal is `billId == openBill.id` **or** unbilled-and-forecast, not `billId == null` alone; bills are not cached, against §298, with the reason.
- ADR §14.2: the recommended grouping key `description | totalInstallments | purchaseDate` measures worst of the eight tried. Phase 6 inherits the sweep.
- `docs/prd.md` Phase 4 acceptance: two figures and a reported gap, not one number matching the app. Say why.
- `docs/prd.md` open decision 5: closed.

**Step 4: Commit**

```bash
git commit -m "docs: record the Phase 4 acceptance and amend the ADR"
```

---

## What this plan deliberately does not build

A plan key. Phase 6 owns it, starting from the eight-key sweep in the research document. Nothing here groups instalment rows across cycles, and the two places that group within a single cycle — Task 12's dedupe and Task 13's guard — are documented as safe only inside one cycle.

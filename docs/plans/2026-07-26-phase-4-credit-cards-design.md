# Phase 4 — credit cards, design

Written 2026-07-26, on the evidence in `docs/research/2026-07-26-phase-4-open-bill-derivation.md`. That document is the source of every number here and records the hypotheses that were tested and rejected; this one says what gets built. Revised the same day after a design review; the findings that changed the shape are marked where they land.

## What ships

Five tools. `getBills` and `getBillSummary` read; `listClosingDays`, `setClosingDay` and `deleteClosingDay` are local state. The ADR's single `manageClosingDate` with an `operation` enum is dropped, closing `docs/prd.md:109`.

**Acceptance, and an amendment to the PRD.** `docs/prd.md` Phase 4 asks for "a number that matches the bank's app". On this evidence that is achievable on one of two real cards and not the other, so the criterion changes: **the tool returns two measured figures whose gap reports the uncertainty, and never a single number chosen by a hidden rule.** On the gold, `committed` is exact at 42,92 while `posted` reads 23,90 because Nubank's feed lags eighteen days. On the Santander the pair is 6.046,52 and 6.409,34 against an app reading of 6.042,44 — a 362,82 spread, and a further 366,90 between `committed` and the app that the research document leaves unexplained. Empty bill lists read as normal. No figure is returned without the date its data stops at.

## The derivation

`src/core/bill.ts`, pure — no fetch, no SQLite, no SDK. The file the ADR's layout at line 171 already reserved.

### Input

`core/bill.ts` receives **every cached row for one card, with no date bound**, plus the `Account` and the bill list. It cannot use `TransactionStore.query`: `TransactionFilter` requires `from` and `to` (`core/contracts.ts:110-121`), and the derivation needs rows outside any window — the gold's materialized instalments run to 2026-11-25, the Santander's sentinel row has no cycle at all, and the wrap-around guard reads *billed* rows from closed cycles.

So `TransactionStore` gains one method:

```ts
/** Every cached row for one card, unbounded by date. The bill derivation needs
    future-dated instalments and closed-cycle history, neither of which a range
    filter can express. */
cardRows(accountId: string): readonly DerivedTransaction[];
```

`DerivedTransaction` rather than `Transaction`, so the self-transfer exclusion can match the same durable leaf `aggregate.ts` does.

### Identifying the open cycle

Four sources, not three, and `closingDateSource` names which one answered:

1. `"open-bill"` — the newest bill's closing day has not passed. That bill **is** the open cycle and `/bills` already carries it. The sandbox card.
2. `"last-closed"` — it has passed. The open cycle is the month after that bill's `dueDate`. Both real cards. `creditData.balanceDueDate` describes the **closed** cycle and must not be read as the open one.
3. `"local"` — no bills, but a closing day stored by `setClosingDay`.
4. `"due-date"` — no bills and no stored day, but `creditData.balanceDueDate` is present: the month after it.

With none of the four, the cycle is not identifiable and the tool returns the utilization alone. *(Review B/M5: the earlier draft ordered 3 and 4 the other way round and its error table refused as soon as the local day was missing, contradicting the fallback list. The local day wins because the user set it deliberately; `balanceDueDate` is a guess the connector made.)*

**Dates are compared as two steps, never as instants.** First extract the bill's calendar day from its UTC parts into `YYYY-MM-DD` — the real connector sends `00:00:00.000Z` and the sandbox `03:00:00.000Z`, and in UTC−3 a UTC midnight falls on the previous day. Then compare that string against `todayIn(clock)` from `core/date.ts:27`, which is `America/Sao_Paulo` and the same calendar `Transaction.localDate` lives in. One calendar, one string comparison. *(Review M6: "compare on UTC parts" alone would have an implementer reach for `new Date().getUTCDate()`, flipping the cycle a day early for three hours every evening.)*

**A stored closing day converts to a cycle by clamping**: `min(day, daysInMonth)`, so 31 in February is the 28th or 29th. A row falling exactly on the closing day belongs to the closing cycle.

### Which rows belong to the open cycle

*(Review B1, and this is the finding that changed the derivation most.)* The earlier draft defined open-cycle rows as "rows with no `billId`". On the sandbox card that yields the empty set and `posted = 0`, because when `/bills` carries the open cycle its transactions carry that bill's id — all three sandbox rows hold `billId = f93561c3`, the open bill. A headline figure of zero on a card holding 265,50 is exactly the confidently-wrong number the PRD's first rule forbids.

One definition covers all four sources:

```
openCycleRows = rows where billId == openBill.id            (source "open-bill")
              ∪ rows where billId is null
                and billForecastDate is absent or ≤ openCycle
futureRows    = rows where billId is null
                and billForecastDate is "0001-01" or > openCycle
```

**The null branch is explicit and deliberate.** Nested `creditCardMetadata` members are omitted rather than nulled, so a row can lack `billForecastDate` entirely. No such row is currently unbilled on any of the three cards — every absent value sits on a billed row — so this branch is written against a case the capture never produced. It resolves to the open cycle because a charge we cannot place is more likely current than future, and dropping a real charge out of `posted` is the worse error.

### The two figures

```
posted        = Σ openCycleRows, excluding self-transfer leaves
materialized  = Σ futureRows
implied       = Σ over deduped openCycleRows of amount × (instalmentTotal − instalmentNumber)
future        = max(materialized, implied)
committed     = utilization − future
```

**`max` is what removes the plan key.** Grouping exists only to stop a plan being counted twice when several of its rows are present. Restricted to the open cycle, a card that posts one instalment per bill contributes one row per running plan, and that row states its own position; a card that materializes the whole plan reports the same total as explicit future rows. The larger of the two counts each plan once under either posting style, with no per-card branch. Seven grouping keys were tried and none is correct on both cards — the sweep is in the research document, and it is Phase 6's problem, not this one's.

**`implied` dedupes within the open cycle.** *(Review B2.)* The recon records card B posting up to five rows of one purchase at once. Five open-cycle rows of a 10× plan would imply 9+8+7+6+5 instead of 9 — the ADR's 45× bug at §14.3, arriving through the door the `max` rule leaves open when a materialized plan is not stamped with a future forecast. Before summing, group open-cycle instalment rows by `description | instalmentTotal` and keep the highest `instalmentNumber`. The cross-cycle pathologies that defeated the seven-key sweep cannot bite here: a wrap-around needs two cycles, and the gold's counter-in-description differs per instalment, so within a single cycle both collapse correctly.

**The wrap-around guard uses raw `description`, deliberately not `descriptionNorm`.** *(Review M2.)* `normalizeDescription` in `core/description.ts` strips exactly the trailing `n/m` this guard needs to see; reaching for it collapses `AMAZON PRIME BR 12/12` and `8/12` into one key, fires the guard on the gold, drops `implied` to zero, and destroys the two-measures-agree corroboration that says the shape is right. The guard reads: if any row of the same raw description with an earlier `localDate` already reached `instalmentNumber == instalmentTotal`, the counter has wrapped, this is a perpetual subscription, and the remainder is zero. Without it the Santander gains 330,00 of phantom commitment the moment its annual fee posts unbilled next cycle.

**Sign.** `Transaction.amountCents` on `CREDIT` is already negated, so a purchase is negative (`pluggy/transaction-mapper.ts:22-31`), while `account.amountCents` on a card is the used limit and is positive. `core/bill.ts` works in bill sign — a purchase increases the bill — and converts once at the boundary. Mixing the two does not produce a meaningless number, it produces a plausible one, which is pitfall #1 wearing a different coat.

**The self-transfer exclusion applies to `posted` only**, never to `materialized`, `implied` or `utilization`. *(Review M1.)* `SELF_TRANSFER_LEAVES` in `aggregate.ts:31` is five leaves rather than the one the earlier draft named, and it is not exported. Move the set and `isSelfTransfer` into `src/core/self-transfer.ts` so `bill.ts` and `aggregate.ts` share one definition without a cycle; both take `DerivedTransaction`, which is why `cardRows` returns that type. Do not match on description — the bill payment reads `PAGAMENTO DE FATURA` on one card and `Pagamento recebido` on the other.

*(One review finding rejected: the report claimed a `setCategory` override on the bill-payment row would re-admit it to `posted`. `isSelfTransfer` matches `row.category === "04000000"` **or** `categoryId ∈ LEAVES`, and an override does not change the durable `categoryId`, so the second branch still excludes it. The exclusion survives an override in the direction that matters.)*

## Tool surface

Money crosses the MCP boundary as **decimal strings via `toDecimal`**, never as cents. *(Review M4: every existing tool does this — `tools/accounts.ts:126`, `tools/balance.ts:106`, `tools/transactions.ts:221` — and emitting `utilizationCents: 917089` beside `getAccounts`' `usedCredit: "9170.89"` hands a model two units for one quantity.)* Cents stay inside `core/bill.ts`.

### `getBills(accountId, limit?)`

```
Credit card statements for one card, newest first.

Use this tool when:
- the user asks what a past bill totalled, or when one was due
- you need the closing day of recent cycles
- the user asks whether a bill was paid

Returns: cycles with closing date, due date, total, minimum payment, finance
charges and payments. Usually these are closed statements, but on some banks the
newest entry is the cycle still in progress — getBillSummary says which. An empty
list means this bank does not publish bills, which is normal on non-regulated
connections.
```

*(Review M9: the earlier text asserted "the cycle in progress is not here", which is false on the exact card the research went looking for.)*

The `Bill` domain type, owned by `core/bill.ts` and mapped in `pluggy/`:

```ts
type Bill = {
  readonly id: string;
  readonly closingDate: string | null;   // YYYY-MM-DD, null on the sandbox connector
  readonly dueDate: string;              // YYYY-MM-DD
  readonly totalCents: number;
  readonly currency: string;             // per-bill totalAmountCurrencyCode
  readonly minimumPaymentCents: number | null;
  readonly financeChargesCents: number;  // summed, not the raw array
  readonly paymentsCents: number;        // summed, not the raw array
  readonly paymentCount: number;
};
```

Charges and payments are summed rather than passed through. ADR §16.2 flags exactly this shape on the liquidated-investment `transactions[]`: an unbounded nested array will dominate a response. `limit` defaults to 12. **Order by `closingDate` descending, falling back to `dueDate`** — do not trust the observed order of `/bills`.

`pageSize=500&page=N` is confirmed working on `/bills`: the capture walked all twelve bills that way. It is a v1 endpoint and still returns the `total`/`totalPages`/`results` envelope, unlike `/v2/transactions`.

### `getBillSummary(accountId)`

```
accountId, institution, currency
cycle { openCycle, closingDate, dueDate, closingDateSource }
utilization, creditLimit, availableLimit
posted, committed, futureInstalments
dataThrough, staleDays
topTransactions[5]
```

```
The credit card bill currently in progress, as two independent estimates.

Use this tool when:
- the user asks what their open or current bill is
- the user asks how much of the card limit is used
- the user is deciding whether to spend more this cycle

Returns: posted, what has actually posted to the open cycle, valid only through
dataThrough; and committed, the used limit minus instalments scheduled for later
cycles. They are measured different ways and usually straddle the real figure,
but neither is a proven bound — quote the gap, not a midpoint. A wide gap means
the card is either reporting transactions late or carrying instalment plans the
API does not detail; staleDays says which. Also returns the limit, the usage and
the five largest charges of the cycle.
```

*(Review B3: the earlier text said the pair "bracket the real figure", which the design's own Known Limits denies and which the Santander disproves — the app sits 4,08 below `posted`.)*

Both figures are always returned. There is no selector choosing one, because a detection rule that silently picks wrong is exactly the confidently-wrong number `docs/prd.md:30` forbids.

**`committed` can go negative** when a card is paid down while materialized instalments remain in the feed. Report it as-is with a flag rather than clamping to zero: a negative open bill is visibly wrong, and a zero is not. `posted > committed` is likewise reported rather than corrected.

**`topTransactions`** are the five largest charges of the open cycle by bill-sign amount — purchases only, credits excluded, self-transfers excluded, drawn from the same `openCycleRows` that produced `posted`. Each carries `id`, `date`, `description`, `amount` as a decimal string, and `category`. Amounts are in bill sign so they read positive beside `posted`.

### `listClosingDays()` · `setClosingDay(accountId, day)` · `deleteClosingDay(accountId)`

Local CRUD over `data.db.card_closing_day`. Three verbs rather than one enum: tool descriptions are the only discovery surface a model gets, and three specific ones teach better than one conditional. `setClosingDay` is an upsert, which is what the SQL does anyway. `day` is validated 1–31 at the boundary and clamped to the month's length at use.

## Contracts and storage

`Bank` gains a fifth method, `getBills(accountId)`. Every one of the seven test files using `tests/fakes/fake-bank.ts` keeps compiling as long as the fake supplies a default.

`TransactionStore` gains `cardRows` as above. A new `ClosingDayStore` contract in `core/contracts.ts`, implemented in `src/storage/closing-days.ts`.

**Bills are not cached.** The ADR at line 298 argues for it. Both consumers — `getBills` itself and open-cycle identification — want the newest bills, at three requests per wallet against a limit of 360. Caching costs a table, a cache migration, a freshness rule and an invalidation path to save those three. The real cost of not caching is that `getBillSummary` reads bills live and transactions from cache, so the two have different ages. A third age is worse and unavoidable: `utilization` comes from the account fetch while `posted` comes from rows as of `dataThrough`, which on the gold is eighteen days behind. That gap is the dominant distortion in the pair, and `staleDays` exists to expose it.

### Migrations

`CACHE_MIGRATIONS` gains `{to: 3}` adding `bill_forecast_date` to `transactions`. Under rebuild the whole list replays against a dropped file, so this is a separate `ALTER` entry rather than an edit to entry 1. **This drops and rebuilds every existing `cache.db` and clears `transaction_sync`, forcing a full re-walk of every account.** That is the point — it is what backfills `bill_forecast_date` onto rows already cached — but it is a slow first run after upgrade, not a bug.

`DATA_MIGRATIONS` gains `{to: 2}` creating `card_closing_day (account_id TEXT PRIMARY KEY, day INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`. `data.db` is never dropped, so this is a genuine incremental migration. Keep it to bare `CREATE TABLE` statements: `db.ts:81` rewrites `CREATE TABLE ` to `CREATE TABLE userdata.` for the `:memory:` ATTACH form, and an index or `ALTER` in the same entry breaks the storage tests.

### Plumbing `billForecastDate`

Both figures depend on a field that reaches neither the domain nor the schema today. Six touch points, and the sixth is the one that fails silently:

1. `.optional()` member on `CREDIT_CARD_METADATA` in `pluggy/wire.ts` — nested members are omitted, never null
2. a line in `cardDetails` at `pluggy/transaction-mapper.ts:92`
3. `billForecastDate: string | null` on `core/transaction.ts`
4. `bill_forecast_date` in cache migration `{to: 3}`
5. `transactionValues` and `rowToDerived` in `storage/transaction-row.ts`
6. **`TRANSACTION_COLUMNS` at `storage/transactions.ts:11-17` and the `ON CONFLICT DO UPDATE SET` list at `:26-48`** — a second, duplicated column list. Miss it and the field never persists: the code compiles, fixture-backed tests pass, and `posted` is wrong only against real data.

### Composition

`.dependency-cruiser.js` rule `only-bin-builds-infrastructure` forbids `^src/(cli|mcp)/ → ^src/(pluggy|storage)/`, so `src/mcp/tools/bills.ts` cannot construct or import the store. The closing-day store and the bill reader arrive through `ToolDeps` (`mcp/tools/result.ts:9-15`) and `Source` (`mcp/source.ts`), built in `src/bin/`. Three files the earlier draft did not name.

## Error handling

Decided per case, as the ADR at line 1014 requires.

| condition | response |
| --- | --- |
| revoked consent, unknown connection | readable `isError` content |
| `accountId` is not a credit card | readable `isError` content naming the account's actual type |
| card never walked, or zero cached rows | `utilization` and the limits, with `posted`, `committed` and `topTransactions` omitted and a line saying the card has not been synced |
| no bills, no stored closing day, no `balanceDueDate` | `utilization` and the limits, plus an explanation that the cycle needs `setClosingDay` — never a guessed cycle |
| empty bill list on `getBills` | normal empty result, not an error |
| transport failure, malformed body | protocol error |

*(Review M8: `dataThrough` returns an empty map for a never-walked account and `prune` at `format.ts:15` drops nulls, so without this row the field would vanish from the JSON while `posted: "0.00"` and `committed` still looked like measurements — violating this design's own "no figure without its date".)*

## Testing

TDD throughout, red first.

`tests/core/bill.test.ts` carries the derivation as table tests: the four `closingDateSource` cases including the UTC-versus-São-Paulo boundary and the February clamp, open-cycle membership under both the `billId == openBill.id` and the `billId is null` arms, the `max` rule under both posting styles, the within-cycle dedupe against a five-row plan, the wrap-around subscription, the null `billForecastDate` branch, the sign conversion, and the self-transfer exclusion applying to `posted` only. Pure, no I/O.

`tests/storage/closing-days.test.ts` runs against `:memory:` with the two-file `ATTACH` form. `tests/storage/migrations.test.ts` and `tests/storage/transactions.test.ts` gain the new version and the new column — the latter specifically asserting `bill_forecast_date` survives a round trip, which is the only thing that catches touch point 6.

Fixtures are synthetic and Pluggy-shaped, built from the captured payloads with amounts replaced — the repo is public. One per posting style, plus the sandbox's open-bill-in-`/bills` case, plus a wrap-around subscription, plus a five-row-at-once plan.

**Every tool parameter gets a test proving it reaches the request**, and `npm run mutation` runs afterward because `core/bill.ts` is inside its scope. Expect survivors on the `max`, the dedupe and the wrap-around guard; those are the three assertions worth writing carefully.

The live acceptance record goes to `docs/research/`, storing totals and counts, never statements or ids.

## Known limits, recorded rather than solved

- **366,90 unexplained on the Santander.** The app was re-read and confirms 6.042,44. Not the refund, not any feed amount times an integer, not the sum of any two debits. Most likely limit consumed by a purchase with no posted row. It is this card's error bar on `committed`.
- **The app's figure is not guaranteed to fall inside `[posted, committed]`.** It lands on `committed` on the gold and 4,08 below `posted` on the Santander.
- **`implied` collapses at the start of a cycle.** It reads only open-cycle rows, so between a bill closing and this month's instalments posting, every running plan is invisible and `committed` jumps toward the full utilization, then walks back down over the month. Both captures were mid-cycle on 26/07 and neither tests this. On a card whose feed lags, it is the normal state rather than an edge case.
- **Mixed posting styles within one card defeat `max`.** A materialized plan and a one-per-bill plan running together resolve to whichever term is larger, losing the other. Not observed; each card in the capture is internally consistent.
- **The wrap-around guard has a designed-in false positive.** Two separate instalment purchases with an identical description, the first completed, zero out the second's real remainder — under-counting `future` and over-stating `committed`.
- **The guard needs history the cache may not have.** After migration 3 rebuilds `cache.db` and before a full walk, it cannot fire.
- **The gold's feed lags eighteen days.** Nubank's, not ours — `staleDays` reports it.
- **The IOF stays in.** Excluding it reproduces the app exactly; excluding a real charge because the residual vanishes is fitting.

## Out of scope

Instalment plans as an entity. Phase 6 owns the plan key, starting from the key sweep in the research document, and it inherits `billForecastDate`, the open-cycle identification and the capture. `docs/prd.md:89` wondered whether Phase 6 had to come first; it does not, because the route that needed a plan key is the route that does not work.

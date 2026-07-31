# Issue #13 — index the open cycle by due month everywhere

## Context

`identifyOpenCycle` (`src/core/bill.ts:53`) labels the open billing cycle with a `YYYY-MM` tag. Three of its four sources derive that tag from the bill's **due date**; `cycleFromStoredDay` (`src/core/bill.ts:116`) derives it from the **closing day**. The two agree only when a card closes and is due in the same month.

The tag is not internal. Its only consumer is `belongsToFutureCycle` (`src/core/bill-rows.ts:190`), which compares it against Pluggy's `billForecastDate` — documented as the *"forecasted bill period in which this transaction is expected to be charged"*, and Pluggy identifies a bill by its `dueDate`. So on a card that closes on the 25th and is due on the 5th, `cycleFromStoredDay` returns a tag one month early, a row of the open cycle compares as `future`, and `posted` loses a charge that `futureInstalments` gains.

In Brazil the gap between closing and due is 7–10 days, so **every card closing after roughly the 21st is due in the next month**. This is not an edge case.

Decided in intake: due month is canonical; the closing→due offset resolves by precedence — stored due day, then the day of `creditData.balanceDueDate`, then assume the same month.

**Known non-goal.** The `local` source only runs when the connector publishes no bills at all (`src/core/bill.ts:60` returns before reading the stored day), so this fixes no number on any card captured in `docs/research/`. It fixes cards whose connector omits the bills product. A second limitation stays open and is not addressed here: on that same path, a row stamped with the just-closed cycle's forecast still counts as posted, because without bills there is no `billId` to exclude it.

## The change

### 1. A resolved pair replaces the bare stored day

`ClosingDay` (`src/core/contracts.ts:171`) grows `dueDay: number | null`, and `ClosingDayStore.set` takes it as a third argument. Explicit `null` rather than an optional property, per the project's "absence is NULL" rule and `exactOptionalPropertyTypes`.

A new pure function in `src/core/bill.ts` resolves the offset:

```
dueMonthOffset(closingDay, dueDay) = dueDay !== null && dueDay < closingDay ? 1 : 0
```

`cycleFromStoredDay` keeps its current arithmetic to find the **closing** cycle, then advances it by that offset via the existing `followingCycle`.

**Pattern: Parameter Object.** `storedDay: number | null` is threaded through `identifyOpenCycle` (`src/core/bill.ts:55`), `formatCycle` (`src/mcp/tools/bill-summary-format.ts:100`) and `datesFromLocalDay` (`:154`). Adding a second loose `number | null` beside it at three call sites invites transposed arguments that typecheck. Replace it with one `CycleDays = { closingDay: number; dueDay: number | null }` value, resolved once in `summarizeDatedCard` (`src/mcp/tools/bill-summary.ts:81`) where both the store row and `account.credit.balanceDueDate` are already in hand.

No other pattern applies. The three-step precedence is an ordered fallback that mirrors the four-source precedence `identifyOpenCycle` already uses, for the reason `docs/plans/2026-07-26-phase-4-credit-cards-design.md:44` gives — the user's value wins over the connector's guess. Dressing three `??` steps as a Chain of Responsibility would be worse than the `??`.

### 2. `datesFromLocalDay` reports the closing date in its own month

`src/mcp/tools/bill-summary-format.ts:154-163` currently puts both dates in the cycle's month. Under due-month labelling the due date belongs there and the closing date belongs `dueMonthOffset` months earlier. Reuse `dateInCycle` and the existing month arithmetic; the due day comes from the same resolved pair, falling back to `account.credit.balanceDueDate`'s day as it does today.

### 3. Storage: `DATA_MIGRATIONS {to: 3}`, and the trap that comes with it

`ALTER TABLE card_closing_day ADD COLUMN due_day INTEGER` — additive, because `data.db` is never dropped (`docs/adr/0001-stack-and-architecture.md:264`), so the cache trick of rewriting migration 1 is unavailable. Existing rows read `NULL`, which is exactly today's behaviour: no regression for anyone who already stored a day.

**This breaks the in-memory test path unless `db.ts` changes with it.** `src/storage/db.ts:78-83` replays `DATA_MIGRATIONS` into an attached `userdata` schema by rewriting `CREATE TABLE ` → `CREATE TABLE userdata.`. An `ALTER TABLE` statement matches nothing, executes unqualified against `main`, and throws `no such table` — taking down every `:memory:` test that opens with `CACHE_MIGRATIONS`, including `tests/fakes/fake-source.ts:69`, which is most of the suite. Widen the rewrite to cover `ALTER TABLE ` as well, and say in a comment that the rewrite must track every statement form the data migrations use.

Then `src/storage/closing-days.ts`: the upsert (`:5-11`) gains the column and the conflict clause, the `SELECT` (`:18`) gains it, and the row mapping (`:31-34`) reads it as `number | null`.

### 4. The tool

`setClosingDaySchema` (`src/mcp/tools/closing-days.ts:34-37`) gains `dueDay: z.number().int().min(1).max(31).optional()`. The handler passes `parsed.data.dueDay ?? null`. Both descriptions change: `setClosingDay` should say the due day is what places the cycle for a card that is due in the month after it closes, and `listClosingDays` should mention it returns both. Descriptions are the only discovery surface a model gets, and a card is stated as "fecha 25, vence 05" in one breath — asking for half of it was the original mistake.

## Acceptance tests

Written against the tool handlers and the core function, not internals. All four fail today.

1. **A card that closes on the 25th and is due on the 5th counts an August-forecast charge as posted, not future.** No bills from the connector, closing day 25 and due day 5 stored, today 2026-07-20, one unbilled row carrying `billForecastDate: "2026-08"`. `getBillSummary` reports the open cycle as `2026-08` and the charge inside `posted`. Today the cycle reads `2026-07`, the row sorts as future, and `posted` is short by that charge.

2. **The same card reports a closing date in the month before its due date.** The cycle block reads `closingDate: "2026-07-25"` and `dueDate: "2026-08-05"`. Today the due date lands in July, one month before the payment actually happens.

3. **A card that closes on the 8th and is due on the 15th is unchanged.** Same shape, closing day 8, no stored due day, the bank reporting a due date on the 15th. The cycle, both dates and `posted` read exactly as they do before the change. This is the shape of every card in `docs/research/2026-07-26-open-bill-probe.md`, and the guard that the fix does not move the common case.

4. **A due day stored through `setClosingDay` reaches the summary.** Store `{accountId, day: 25, dueDay: 5}` through the real SQLite store, then ask `getBillSummary` for the same card and get the due-month cycle back. This one runs against `createClosingDayStore` on `:memory:` rather than the hand-rolled `ClosingDayStore` literals at `tests/mcp/tools/bills.test.ts:184` and `tests/mcp/tools/closing-days.test.ts:21`, because those fakes will happily return a `dueDay` that the schema, the upsert and the `SELECT` never actually persist. It is the only test that proves the column, the store, the tool and the derivation connect.

`listClosingDays` returning the stored due day is covered incidentally by 4 and needs no test of its own.

## Files

| File | Change |
|---|---|
| `src/core/contracts.ts:171-181` | `ClosingDay.dueDay`, `set()` third argument |
| `src/core/bill.ts:53,116` | `dueMonthOffset`, `cycleFromStoredDay` advances by it, `CycleDays` parameter |
| `src/mcp/tools/bill-summary.ts:81,104-109` | resolve `CycleDays` once; `storedClosingDay` stops discarding the rest of the row |
| `src/mcp/tools/bill-summary-format.ts:100,115-135,154-163` | thread `CycleDays`; `datesFromLocalDay` shifts the closing date back |
| `src/mcp/tools/closing-days.ts:34-37,84-91` | optional `dueDay`, three descriptions |
| `src/storage/migrations.ts` | `DATA_MIGRATIONS {to: 3}` |
| `src/storage/db.ts:78-83` | rewrite also qualifies `ALTER TABLE` |
| `src/storage/closing-days.ts:5-11,18,31-34` | column through upsert, select, mapping |

Tests, all existing files — `tests/` mirrors `src/`, nothing new outside the fixture:

`tests/core/bill.test.ts` (the `CYCLE_CASES` table and the call at `:69`; the case at `:38-42` legitimately moves from `2026-08` to `2026-09`, since closing 20 with a due day of 15 is a split-month card), `tests/mcp/tools/bills.test.ts:184-190,350-370`, `tests/mcp/tools/closing-days.test.ts:16-39,59-83,97-106`, `tests/storage/closing-days.test.ts`, `tests/storage/migrations.test.ts:24-34`, and `tests/fakes/bill-builder.ts:11-21` (`BillFixture` cannot express a due day today).

New fixture `tests/fixtures/split-month-card.ts`, following `tests/fixtures/one-per-bill-card.ts`: one `export const splitMonthCard = billFixture({...})` with `storedDay: 25`, a due day of 5, no bills, and one unbilled row forecast to the due month. Every fixture in that directory is a same-month card today, which is why the whole suite passes under both conventions.

Docs: amend `docs/plans/2026-07-26-phase-4-credit-cards-design.md:39-45` to state the convention in one line, since that section is where the divergence was written down. The ADR does not state a cycle convention, so it stays as is.

## Verification

TDD, red first: write each acceptance test, watch it fail for the stated reason, then implement.

```
nvm use
npm run typecheck && npm run lint && npm run deps && npm test
npm run mutation          # src/core changed — read the survivors
```

`npm run mutation` matters more than usual here: the whole bug is that the existing assertions cannot tell the two conventions apart, and a surviving mutant on `dueMonthOffset` means the new fixture still is not discriminating.

Also confirm by hand that the migration is additive rather than destructive, since `data.db` holds user state that is never rebuilt: open a copy of a real `data.db` at version 2, run the binary, and check that `card_closing_day` keeps its rows with `due_day` null.

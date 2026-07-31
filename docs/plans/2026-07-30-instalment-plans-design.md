# Reconstructing an instalment purchase from its rows: `listInstalmentPlans` design

Written 2026-07-30, against issue #17 and `docs/backlog/01-instalment-plans-tool.md`. Revised the same day after a staff-engineer review, which found three blockers. Findings applied are marked in place.

Every figure below was read out of a real `cache.db` on 2026-07-30: 1754 rows, 116 of them carrying instalment metadata, across 3 credit cards and 3 bank accounts. Where this document disagrees with the backlog ticket, the disagreement is a probe result and is called out as such. The backlog's appendix is right about the traps and wrong about two figures, both corrected below.

## What the tool answers

A 12x purchase arrives as twelve rows and nothing puts them back together. `getTransactionDetails` shows the metadata but caps at 20 ids and needs them up front, so it cannot find a plan, only describe one you already located. The question "what am I still paying off, and when does it end" therefore has no answer on the MCP surface, and a R$ 2.999,00 commitment running to 2027-05 is invisible to every tool we ship.

`listInstalmentPlans` groups a card's rows into purchases and reports each one. Open plans by default. Settled and reversed plans behind `includeSettled`, because the issue's own use case is going through statements, where a finished 12x purchase still needs to be recognisable as one purchase.

There is no date range. A plan is defined by its own span, not by a window, and a window is exactly how you miss the plan that started before it.

Deliberately out of scope: a per-month schedule of future instalments. Given the per-instalment amount, the remaining count and the final cycle, the instalments occupy consecutive cycles ending there, so the schedule is derivable by the caller. The only case where publishing one would add information is a plan with irregular cadence, which is the case we have no data to support.

## Shape of the derivation

One pure function in `src/core/instalment-plans.ts`. No I/O, no store, no clock:

```ts
export function deriveInstalmentPlans(input: {
  readonly rows: readonly DerivedTransaction[];
  readonly bills: readonly Bill[];
  readonly openCycle: OpenCycle | null;
}): readonly InstalmentPlan[];
```

The MCP layer fetches `cardRows(accountId)`, the card's bills and the stored closing day, resolves the open cycle, and hands values in. `core/` importing a store would break the rule the dependency cruiser enforces, and it would force every unit test to build a fake store to test arithmetic.

## Plan identity

The feed has no plan id. The three obvious keys each fail on real rows.

**Amount is out.** The final instalment drifts by a centavo (`PUCMINAS` 361,70 then 361,69; `AIRBNB * HMJT5CKK2B` 97,63 twice then 97,61). Keying on it splits one plan in two.

**Description is out, normalized or not.** Nubank renames mid-plan. `normalizeDescription` already strips the trailing counter, which is why the backlog's "normalizedDescription" needs no new code, but it does not undo the rename:

```
"Amazon Prime 6/12"     -> "AMAZON PRIME"
"AMAZON PRIME BR 7/12"  -> "AMAZON PRIME BR"
```

The backlog's proposed key carries `descriptionNorm`, so it breaks the very plan its own appendix uses as trap 2.

**The purchase day is out.** `purchase_date` is a full ISO instant, not a day, and truncating it collides. Four collisions in this cache, all between unrelated merchants on the same card, same day, same instalment count:

```
2025-09-13  2x   AVIATOR (161,82)      /  00039 SH RIO SUL (59,95)
2026-01-13  2x   LOJAMIRANTE (70,07)   /  BR1 *LUZZO (59,42)
2026-04-04  2x   PUCMINAS (175,00)     /  CONTABILIZEI (126,92)
2026-05-18  2x   AIRBNB * HME5HP3S4H   /  OFICIAL FARMA
```

The untruncated instant, on the other hand, is shared to the millisecond by every row of a real plan, including the renamed ones, and produces zero duplicate instalment numbers across the whole cache.

It still cannot stand alone, because some rows carry a `purchase_date` that is really a posting date. `ANUIDADE DIFERENCIADA` stamps a new one every month (`2026-03-09T00:00:00Z`, `2026-04-08T00:00:00Z`, and so on), so keying on the instant turns one annual fee into twelve one-row plans, each claiming eleven instalments outstanding. That is R$ 7.260 of invented debt against a real R$ 385.

An instant covering two or more rows with distinct counters is strong evidence of a purchase. An instant covering one row is no evidence either way: it can be a purchase whose other instalments have not posted, like `AMAZON BR` 1/10, or a posting date, like each annual fee row.

### The rule

Three steps over one card's **debit** rows, ordered by `localDate`. Credits never enter grouping; they are applied afterwards, under Reversals.

**1. Bucket.** Group by `accountId | purchaseDate | instalmentTotal` on the untruncated instant. Buckets holding two or more rows are plans and own their rows. Everything else is residual.

**2. Reconcile.** A residual row joins an existing bucket from step 1 when they share `accountId | descriptionNorm | instalmentTotal`, the bucket has that counter free, and the bucket's highest counter is below the residual's. Among candidates, the bucket with the highest such counter wins; ties break on the latest `localDate`; a remaining tie leaves the row unjoined and adds a note.

Step 2 exists because a plan can straddle instants. A connector that changes the instant mid-plan gives `[1/3 at P, 2/3 at P, 3/3 at Q]`, and without reconciliation the 3/3 becomes its own settled plan while the first two report one instalment still owed. It must not over-merge: the cache holds five complete `MERCADOLIVRE*MERCADOL` 2x plans plus a sixth `1/2` posted 2026-07-25, and since every existing bucket already holds counter 1, the singleton correctly becomes a new plan.

**3. Segment.** What is still residual groups by `accountId | descriptionNorm | instalmentTotal`, cutting a new plan whenever the counter fails to advance. A counter that goes 12 then 1 is a boundary. A counter that goes 1 then 1 is also a boundary. What the boundary *means* is a separate question, answered under Renewals.

The non-monotonic cut is strictly stronger than `trackInstalmentHistory` in `core/bill-rows.ts:160`, which only fires after a completed `N/N` and therefore misses two `1/10` rows in a row.

## Reversals

A charged-then-refunded plan still looks open if only debits are grouped. An earlier draft of this document fixed that with a cancellation pass running *before* grouping, and the plan review killed it: cancellation dropped both rows, so a refund of one instalment of a plan that grouping had already claimed could not adjust that plan, and this document's own promise that a partially reversed plan keeps its identity had nowhere to live.

Credits are applied afterwards instead, as offsets against a position of a plan that already exists.

Grouping sees debits only, so a credit can never create, split or join a plan. That alone kills the phantom the earlier draft was defending against: the `Araujo Loja` credit and debit carry different `purchase_date` instants (`T01:01:01Z` and `T14:32:34Z`), and with credits excluded there is no pair of counter-`1` rows for segmentation to split into two plans.

A credit offsets a materialized position when they share `accountId | descriptionNorm | instalmentTotal | instalmentNumber | abs(amountCents)` **and** fall on the same billing cycle. An offset position leaves paid, leaves remaining, and leaves both money totals. When every materialized position of a plan is offset the plan is reported with `status: "reversed"` and excluded from `totals`; when only some are, the plan keeps its identity and its status, and the response carries an adjustment notice.

Three constraints, each closing a way the naive rule eats real debt:

- **Offsets never form plans.** A credit matching no position is dropped with a notice. It can never surface as a purchase with positive instalments.
- **Same cycle.** Without it, a refund of an old purchase annuls a new one at the same merchant, same amount, same counter, months later.
- **One candidate.** Two debit positions against one credit is undefined, so it is not decided silently: nothing is offset and the response carries a notice naming the rows.

The blast radius on this cache is one credit, and both of its rows sit on the same bill, so the same-cycle test passes on the only case that exists:

```
credit rows carrying instalment metadata at all: 1
that row:                                        ARAUJO LOJA 1/2, +874,50, bill 14cf4936
its matching debit:                              ARAUJO LOJA 1/2, -874,50, bill 14cf4936
```

The backlog matched credits by merchant inside the plan's cycle range instead. That is what produces its own trap 4b: `GPA BAR E RESTAURANTE` has a one-off charge of 507,56 refunded in full alongside an unrelated 2x plan of 262,15, and merchant-level matching flags the plan. The offset rule is immune structurally rather than by heuristic, because the GPA refund carries no instalment metadata and so matches no position.

## Paid, remaining, and truncated history

**Paid is a position, not a row count.** The highest counter provably on a closed bill is the paid position; everything above it is remaining. Counting rows instead is wrong the moment the cache does not reach back to the purchase, which is the normal case: the first `ANUIDADE DIFERENCIADA` row in this cache is 6/12, so counting its seven closed rows reports 7 of 12 paid on a plan the bank finished, inventing five instalments of debt.

**Proof of closure comes from the bill list, not from the partition.** `partitionBillRows` skips any row whose `billId` is set and is not the open bill (`bill-rows.ts:138`), which treats an unknown bill id as historical without evidence. A plan classifier takes the card's bills and asks whether the row's `billId` is a bill that has closed. An id absent from the list is unproved and counts as remaining.

This is not cosmetic: `AMAZON BR` 1/10 and `PAGUEMENOS01232` 1/2 are both posted but unbilled, so the honest answer is ten and two outstanding, not nine and one.

**A leading gap makes the purchase total unknowable.** When the lowest observed counter is above 1, the missing instalments were never cached and their amounts are not recoverable. `purchaseTotal` is `null` in that case, and the plan carries a note. The annual fee is exactly this shape: R$ 385 outstanding is right, R$ 385 total is not, the plan cost R$ 660.

**When the open cycle cannot be identified**, count conservatively: a row counts as paid only when its bill is provably closed, anything unprovable counts as remaining, `finalCycle` is `null` and `finalCycleSource` is `"unknown"`. The tool never reports a smaller debt than the data supports.

`identifyOpenCycle` has three inputs, not two: the connector's bills, a stored closing day, and `creditData.balanceDueDate` (`bill.ts:53`). The unknown state needs all three to fail, which is rarer than the empty `card_closing_day` table suggests but not exotic, since `getBills` already describes a connector publishing no bills as normal on non-regulated connections.

That state must name its own remedy. `setClosingDay` already exists and already does this job, but a bare `null` is a dead end the model cannot recover from, so the notice says what to call:

```
"no closing day stored for this card; call setClosingDay to get final cycles"
```

## Final cycle

Instalment *k* lands on the *k*-th bill. `MP *VISAMUNDO` runs 1/3 and 2/3 on consecutive Santander bills (`14cf4936` then `48c42481`), and the completed `SKY OTICA` ran 1/3, 2/3, 3/3 across three consecutive bills. The backlog attaches specific closing dates to those bills and gets one of them wrong; the cadence is the claim that matters and it holds.

**The cycle domain is the due month.** This is not free choice: `identifyOpenCycle` tags cycles by the month they fall due, `belongsToFutureCycle` compares that tag against `billForecastDate`, and `docs/plans/2026-07-29-open-cycle-due-month-design.md` settled the convention repo-wide. A second convention here would produce two different answers to "which cycle" inside one codebase.

Precedence for a row's cycle, first match wins:

1. `billId` names a bill in the card's list, so the cycle is that bill's due month.
2. The row carries no bill at all and is not forecast past the open cycle, so the cycle is the open cycle's tag.
3. Otherwise the row has no established cycle.

A row carrying a bill id we never fetched stops at rule 1 rather than falling through to rule 2. It demonstrably belongs to some bill, and assuming that bill is the open one would place an old row on the current cycle. Such a row neither counts as paid nor anchors a projection.

`billForecastDate` is deliberately absent from that list, reversing an earlier draft of this document. Its own docblock records why (`transaction.ts:45`): one connector stamps the closed cycle onto purchases made after it closed, so the field is compared against the open cycle and never read as an absolute month. `belongsToFutureCycle` uses it exactly that way. Reading it as truth here would import a known-bad value straight into a money figure.

`finalCycle` therefore anchors on the highest-numbered instalment whose cycle is established, advancing by `instalmentsTotal - thatCounter` months. `AMAZON PRIME BR` has no billed row past 8/12, so the anchor is that row on its closed bill and the projection carries four months, rather than trusting what the 12/12 row forecasts.

This still corrects the backlog's expected output, by a different route. The appendix reads the local month of the 12/12 row, `2026-11-25`, and says the plan ends `2026-11`. The bill that instalment lands on falls due the following month, so the answer is `2026-12` and the fixture has to say so.

`finalCycleSource` is `"reported"` when the final instalment's own row has an established cycle, `"derived"` when the cycle was projected from an earlier anchor, and `"unknown"` when no row of the plan has a cycle at all. The distinction has to survive to the wire because banks genuinely differ:

| | Publishes future instalment rows | Instalment row dating |
|---|---|---|
| Santander | No | 1/N at purchase, later ones dated on the bill close |
| Nubank | Yes | future rows dated ahead, 25/ago through 25/nov |
| MeuPluggy | Yes | 2/2 already dated 2026-08-03 |

A derived cycle is a projection from observed cadence. Presenting it as reported by the bank would be a lie the caller has no way to detect.

## Renewals

Step 3 emits a boundary whenever a counter fails to advance. The boundary is mechanical; what caused it is an interpretation, and the two must not be conflated. Two `1/10` rows under one description are two purchases. A completed `12/12` followed by `1/12` is a renewal. Both are the same mechanical event.

So the plan carries `renewal: true` only when the preceding segment under the same key reached its own `N/N` and the next segment starts at 1. Anything else is a boundary with no claim attached.

`ANUIDADE DIFERENCIADA` satisfies it: 6/12 through 12/12, then 1/12. It is not a purchase and it renews forever, and filtering it out by default would hide R$ 385 of real debt, which is the failure the issue is about. Flagging lets the caller decide.

## Money

Integer cents everywhere inside, decimal strings at the boundary through `toDecimal` (`mcp/format.ts`). Serialize through `textResult`, which prunes only null and undefined, so a plan with zero remaining survives.

**Sum what is published, estimate only what is not.** Both totals add up the materialized rows at their real amounts, one per distinct counter, and fill unmaterialized positions at `instalmentAmount`, taken from the highest-numbered materialized row. Multiplying count by amount instead discards exact data the bank already sent: a plan whose remaining rows are published as 100,00 and 99,99 owes 199,99, and the product says 199,98.

`remainingTotalSource` and `purchaseTotalSource` are `"reported"` when every position in that figure was materialized and `"estimated"` when any was filled in. An estimate can land above or below the truth, since the drifting instalment can round either way, and the tool description says so rather than leaving it to be discovered.

`purchaseTotal` answers the issue's "what did I actually commit to when I bought it", and is `null` when the plan's history is truncated at the front, as described above. `prune` strips nulls, so an unknown figure is absent from the wire rather than present and null. Absence is this repo's encoding for "we do not know", and the tool description has to say what it means, because an absent number is otherwise indistinguishable from a forgotten one.

`purchaseDate` is emitted as a day, and only when every row of the plan agrees on it. Plans identified through step 3 on a per-row posting date get `null`, because publishing a posting date under the name "purchase date" is false. `AMAZON BR`, a single row with a real instant, keeps 2026-07-18.

`merchant` is the `descriptionNorm` of the highest-numbered materialized row, breaking ties on `localDate` then id. Identity ignores the description on purpose, so the displayed name needs its own rule; this one makes the renamed Amazon plan report `AMAZON PRIME BR`.

## Tool contract

Register `registerListInstalmentPlans` in `REGISTRARS` (`mcp/server.ts:36`).

```
Lists credit card purchases still being paid in instalments.

Use this tool when:
- The user asks what they are still paying off, or when a purchase finishes.
- You need committed future spending before judging whether a new purchase fits.
- You need to explain why a card's used credit exceeds its current bill.

Returns: One entry per plan with the merchant, what the purchase cost, the
per-instalment amount, instalments paid and remaining, the money still owed,
and the cycle the last instalment lands on. Each of those three is marked
`reported` when the bank published the underlying rows and `estimated` or
`derived` when it was projected from the instalments that did arrive; an
estimate can be a centavo either side of the truth. A missing purchase total
means the cache does not reach back to the first instalment. Cycles are the
month a bill falls due. Open plans only unless `includeSettled` is set.
```

Input, all optional, validated with Zod at the boundary: `accountId` scopes to one card, `connectionId` to one connection, `includeSettled` (default `false`) adds settled and reversed plans.

```json
{
  "plans": [{
    "card": "AADVANTAGE MASTERCARD PLATINUM",
    "accountId": "cca6e1a8-…",
    "merchant": "AIRBNB * HMJNKQKKPE",
    "purchaseDate": "2026-06-28",
    "purchaseTotal": "815.00",
    "purchaseTotalSource": "estimated",
    "instalmentAmount": "407.50",
    "instalmentsPaid": 1,
    "instalmentsTotal": 2,
    "instalmentsRemaining": 1,
    "remainingTotal": "407.50",
    "remainingTotalSource": "estimated",
    "finalCycle": "2026-08",
    "finalCycleSource": "derived",
    "status": "open",
    "renewal": false
  }],
  "totals": { "planCount": 11, "remaining": "…" },
  "notes": [],
  "dataThrough": [{ "connectionId": "…", "through": "2026-07-27" }],
  "unavailable": []
}
```

`status` is `open`, `settled` or `reversed`. `totals` counts open plans only, renewals included, reversed excluded. `notes` carries the ambiguity and adjustment notices the rules above refuse to resolve silently, and the missing-closing-day notice.

Sort by `finalCycle` ascending with nulls last, then `remainingTotal` descending, then `accountId` and `merchant` so the order is total and the output is diffable.

Accounts and unavailability resolve through `reader.load(deps.source.connections)`, the same path `listTransactions` uses, which performs the existing freshness reconciliation through `walkIfStale`. There is no force refresh, and `dataThrough` travels with the response because a stale feed silently understates every plan. An unreachable connection returns readable content with a notice, never a protocol error.

## What this does not change

The backlog asked for the grouping to live in one place, shared with `getBillSummary`. That moved to ticket 03 and the backlog's acceptance criterion was amended to match, rather than left contradicting this design.

The review argued for sharing identity now and keeping bill-summary arithmetic behind an adapter. That does not buy what it looks like it buys. `impliedCents` sums, per open-cycle bucket, the other positions in the cycle plus the unposted tail; the buckets *are* the arithmetic's input, so swapping whole-history identity underneath while "preserving the arithmetic" moves the number anyway, only less visibly. The choice is between moving `committed` in a change whose purpose is a new tool, or moving it in a change whose entire purpose is that move.

Two identities coexisting for one release is a real cost, bounded by the fact that `deriveImpliedCents` is private, is never exposed on the wire, and answers a different question: what falls due after this cycle, against what is still owed. Ticket 03 requires diffing both implementations per card against a real cache and writing down every difference before switching.

The new module therefore imports nothing from `bill-rows.ts` and leaves `deriveImpliedCents` alone.

## Tests

TDD, red before green. Table tests: one array of cases, one loop, one assertion body. Fixtures built by hand in `tests/fixtures/`, since the repo is public and no real statement may be committed.

Identity, in `tests/core/instalment-plans.test.ts`:

1. Centavo drift on the final instalment stays one plan.
2. A rename mid-plan under a shared instant stays one plan (`Amazon Prime 6/12` then `AMAZON PRIME BR 7/12`), and reports the later name.
3. Two merchants sharing a card, a day and an instalment count stay two plans.
4. A plan straddling steps 1 and 2, `[1/3 at P, 2/3 at P, 3/3 at Q]`, comes back as one plan with one instalment remaining.
5. A residual whose counter is already taken by every candidate bucket becomes a new plan (the MercadoLivre `1/2` case).
6. A per-row posting date under one description with a restarting counter yields two plans, the second flagged `renewal`, both with a null `purchaseDate`.
7. Two `1/10` rows with no shared instant yield two plans and neither is flagged `renewal`.

Paid, money and cycles:

8. A row in the open cycle counts as remaining, not paid.
9. History truncated at the front reports paid by position, not by row count, and returns a null `purchaseTotal` (the `[6/12 … 12/12]` case, which must come back settled).
10. A bill id absent from the card's bill list counts as remaining, not paid.
11. Materialized remaining rows are summed at their real amounts; only unmaterialized positions are estimated, and the source fields say which happened.
12. `finalCycle` projects from the highest-numbered instalment with an established cycle, and a misleading `billForecastDate` on a later row does not move it (the `AMAZON PRIME BR` 12/12 case, which resolves to `2026-12` from the 8/12 anchor).
13. No identifiable open cycle and no billed row yields `unknown`, an absent `finalCycle` and the notice naming `setClosingDay`.
14. A settled plan is absent by default and present under `includeSettled`.

Reversals:

15. A plan whose every materialized position is offset is reported `reversed` and excluded from `totals`.
16. The same credit and debit months apart offset nothing, and both plans survive.
17. A refund with no instalment metadata leaves a same-merchant plan untouched (the GPA case).
18. A live plan on the same merchant and the same day as a reversed one survives (`Araujo Loja` 1166,00 against 874,50).
19. Two debit positions matching one credit offset nothing and produce a note.
20. A plan with one of three positions offset keeps its identity, is not marked `reversed`, drops that position from paid, remaining and both totals, and produces an adjustment note.
21. A credit matching no position forms no plan and produces a note.

Every tool parameter needs a test proving it reaches the request: `accountId`, `connectionId` and `includeSettled` must each be shown to change the result. The prior Go implementation shipped a declared filter that was parsed, validated and never read.

Run `npm run mutation` afterwards, since `src/core/` is in Stryker's scope, and either kill each survivor or suppress it with a reason.

## Validation

`npm run typecheck`, then `npm run lint`, then `npm run deps`, then `npm test`, in that order.

## The acceptance oracle has to be regenerated

The backlog appendix lists ten open plans totalling R$ 5.853,07. That number is not usable as written, for three reasons the review surfaced and a probe confirmed:

- It omits `MERCADOLIVRE*MERCADOL` `1/2`, R$ 39,45, posted 2026-07-25, which adds a plan and R$ 78,90.
- It omits the annual fee's R$ 385, which this design deliberately includes and flags.
- It reads `AMAZON PRIME BR` 12/12 as ending 2026-11, where the due-month convention says 2026-12.

The cache also moved: the appendix was written against 1741 rows through 2026-07-23, and the same cache now holds 1754 rows through 2026-07-27.

So the end-to-end fixture is generated, not copied: freeze a snapshot, run the derivation, review every plan by hand, and commit the result together with the snapshot it came from. The bank app remains the only oracle that confirms any of it, and one card should be checked against it before the numbers are trusted.

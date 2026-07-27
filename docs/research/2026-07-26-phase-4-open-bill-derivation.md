# Deriving the open bill without a plan key — 2026-07-26

Second capture against the same three connections on connector 200, taken to answer the four questions `docs/research/2026-07-26-open-bill-probe.md` left open before Phase 4 could be written. Read-only: `GET /items/{id}`, `/accounts?itemId=`, `/bills?accountId=`, `/bills/{id}`, `/v2/transactions?accountId=`, plus four exploratory paths that do not exist. 1271 card transactions, 26 bills, three credit accounts. Figures are the author's own and are the point of the document; no transaction ids, card numbers or third-party statement detail appear.

Read the earlier probe first. This document does not repeat it — it answers it, and in two places it corrects it.

## The two numbers to beat, re-read

Both targets held at capture time, and the Santander was re-read from the bank app after the analysis, which matters because one hypothesis below turned on whether it had moved.

| card | account | utilization (`balance`) | open bill, from the app |
| --- | --- | ---: | ---: |
| AAdvantage Mastercard Platinum (Santander) | `cca6e1a8` | 9.170,89 | **6.042,44** |
| gold (Nubank) | `c2f080cb` | 98,52 | **42,92** |
| sandbox | `6115b6de` | 265,50 | — |

## Question 1 — there is no API route to a bill's composition

Closed, and negatively. `GET /bills/{id}` returns the list entry's fields plus `createdAt` and `updatedAt`; it carries no line items and no reference to the transactions that compose it. The three other candidate paths do not exist on this plan: `/bills/{id}/transactions` and both spellings of an instalments product answer 403, and `billId` is rejected outright as a transaction filter — `400 property billId should not exist`. `/bills?from=` returns 200 and **ignores the parameter**, answering with all twelve bills, which is worse than rejecting it.

So a payment plan is reconstructible from the transaction feed or it is not reconstructible at all. Nothing else in the API knows about it.

## Question 2 — posting style is detectable, and it stopped mattering

The earlier document framed this as "detect the posting style, then pick a strategy". The detection works — a card that materializes future instalments emits unbilled rows whose `billForecastDate` is beyond the open cycle, and the gold emits four while the Santander emits none. But the strategy split it was meant to feed turned out to be unnecessary, for the reason in "The rule" below.

## The open cycle is the month *after* the newest closed bill, and sometimes it is in `/bills`

The earlier document's arithmetic is right and its wording invited an off-by-one that cost an hour here. `creditData.balanceDueDate` is `2026-07-15` on both real cards and describes the **closed** cycle; the cycle in progress is due `2026-08-15`. Any rule that reads the open cycle tag off the newest bill's `dueDate` without shifting a month will filter the wrong rows and, on the gold, subtract the bill payment from the open bill.

**And "the newest bill is always closed" is false.** The sandbox card returns two bills, the newer of which is due `2026-08-15` with a total equal to the account's `balance` — it *is* the open cycle, and it is in `/bills`. A third behaviour neither the ADR nor the earlier probe had seen. Identification therefore has three cases: a newest bill whose `billClosingDate` has not passed is the open cycle; otherwise the open cycle is the month after that bill's `dueDate`; and with no bills at all it falls back to `balanceDueDate` plus a month, or to the locally stored closing day.

## Two opposite pathologies, and why no grouping key survives both

The earlier document identified the Santander's missing plan key. The capture found a second failure of the same machinery on the gold, pointing the other way.

**The Santander runs a perpetual subscription disguised as a plan.** `ANUIDADE DIFERENCIADA` posts 55,00 monthly and its counter wraps: `6/12` in 2025-08 through `12/12` in 2026-02, then `1/12` in 2026-03 through `5/12` in 2026-07. Twelve rows, one description, and `totalInstallments` describes a billing rhythm rather than a commitment. This single row family is what inflated the earlier document's implied-remainder figure to 9.612,81. Collapsing it needs a **coarse** key.

**The gold embeds the counter in the description, and renames mid-plan.** Its Amazon Prime rows read `Amazon Prime 1/12` … `Amazon Prime 6/12`, then `AMAZON PRIME BR 7/12` … `AMAZON PRIME BR 12/12`. Grouping by description fragments one plan into twelve, each inventing a remainder. Collapsing it needs a **fine** key that also strips the counter and survives the rename.

Seven keys, scored against what each card's implied remainder must be for the identity to close — 2.699,10 on the Santander, 0,00 on the gold:

| key | Santander (want 2.699,10) | gold (want 0,00) |
| --- | ---: | ---: |
| `description \| total \| purchaseDate` | 6.636,05 ✗ | 1.142,16 ✗ |
| `description \| total` | 2.699,10 ✓ | 1.069,03 ✗ |
| `strip(description) \| total` | 2.699,10 ✓ | 83,40 ✗ |
| `strip(description) \| total \| amount` | 4.801,36 ✗ | 83,40 ✗ |
| `strip(description) \| total \| cardNumber` | 2.699,10 ✓ | 236,30 ✗ |
| `amount \| total` | 4.801,36 ✗ | 0,00 ✓ |
| `amount \| total \| cardNumber` | 4.801,36 ✗ | 190,40 ✗ |
| `amount \| total \| cardNumber \| payeeMCC` | 4.801,36 ✗ | 190,40 ✗ |

No key is correct on both, and the best candidate still leaves 83,40 of phantom commitment against a bill of 42,92. `strip()` removes a trailing `n/m`; the residue is the rename, which no mechanical key reaches.

The first row is the key the ADR's §14.2 amendment recommends, on the strength of the recon counting 56 correct groups on card B. It is the worst of the eight here, because `purchaseDate` is stamped per instalment rather than per purchase on the Santander — the two documents disagree, and this is the measurement that settles it against the ADR.

Two caveats on how much this table proves. The targets bake in the 366,90 residue that the next section leaves unexplained, so a ✓ means "correct once an unexplained term is subtracted". And eight keys is a sample of the space, not a proof of impossibility — 4.801,36 against a target of 2.699,10 is far outside any plausible correction, so the conclusion holds, but Phase 6 should read this as strong evidence rather than a closed question.

**This is also the finding Phase 6 has to start from**, since grouping rows into plans is that phase's whole job. It does not block Phase 4 — see below — which settles the roadmap question `docs/prd.md:89` raised about Phase 6 possibly having to come first. It does not.

## The rule — no plan key, no grouping, no per-card strategy

Grouping exists to stop the same plan being counted twice when several of its rows are present. Restrict the implied remainder to rows in the **open cycle** and the problem dissolves: on a card that posts one instalment per bill, each running plan contributes exactly one such row, and that row states its own position. A card that instead materializes the whole plan reports the same total as explicit future rows. Taking the larger of the two counts every plan exactly once under either posting style, with no branch.

```
unbilled        = rows with no creditCardMetadata.billId
future rows     = unbilled where billForecastDate is "0001-01" or > openCycle
open-cycle rows = the rest of unbilled

posted        = Σ open-cycle rows, excluding category 05100000
materialized  = Σ future rows
implied       = Σ over open-cycle rows of amount × (totalInstallments − installmentNumber)
future        = max(materialized, implied)
committed     = utilization − future
```

| card | materialized | implied | future | committed | posted | app |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Santander | 62,45 | 2.761,55 | 2.761,55 | 6.409,34 | 6.046,52 | 6.042,44 |
| gold | 55,60 | 55,60 | 55,60 | **42,92** | 23,90 | 42,92 |
| sandbox | 0,00 | 0,00 | 0,00 | 265,50 | 0,00 | — |

Exact on the gold, and the two independent measures of its future instalments **agree to the cent**, which is the corroboration that says the shape is right rather than fitted.

**Excluding the bill payment costs nothing.** Both cards categorize it as `05100000` Credit card payment, which `src/core/aggregate.ts:31` already excludes from headline totals with a test at `tests/core/aggregate.test.ts:19`. The MAXMILHAS refund arrives as `12000000` Travel and correctly stays inside the bill.

## What the rule does not explain

**A residue of 366,90 on the Santander, and it is real.** The bank app was re-read after the analysis and still says 6.042,44, so this is not an artefact of when the target was captured. Hypotheses tested and rejected: it is not the MAXMILHAS refund (401,14 — subtracting it overshoots to 34,24 low), not any single feed amount times an integer, and not the sum of any two unbilled debits. The remaining explanation is limit consumed by a purchase that has posted no row at all, which is invisible in this API by construction. Treat 6% as this card's error bar on `committed`, not as a bug to be fixed by more arithmetic.

**The gold's `posted` figure is 44% low, and the algorithm is not at fault.** Its feed stops at 2026-07-14 while the account was updated 2026-07-26 19:39 — an eighteen-day lag confirmed as Nubank's, not a pagination window, since the feed carries rows from 2025-07-31 and future-dated instalments out to 2026-11-25. Feed freshness per card at capture: Santander last row 07-23 against an update at 07-26 02:26; gold 07-14 against 07-26 19:39; sandbox 07-14 against 07-23 16:20.

**The app's number is not guaranteed to sit inside `[posted, committed]`.** On the gold it lands exactly on `committed`; on the Santander it lands 4,08 *below* `posted`. The pair is an empirical range whose width reports uncertainty, not a proven bound, and the difference in width is diagnostic — 19,02 of staleness on one card, 362,82 of unexplained residue on the other.

**The rule has a known expiry.** When `ANUIDADE 6/12` posts unbilled into the open cycle next month, `implied` gains 330,00 of commitment that does not exist. The guard is cheap and needs only history already cached: if an earlier row of the same description already reached `installmentNumber == totalInstallments`, the counter has wrapped and the remainder is zero. Build it with the rule, not after it.

## Question 3 — the IOF is not explained, and should stay in

R$ 4,08 on 10/07, `IOF DESPESA NO EXTERIOR`. Excluding it reproduces the app exactly and including it lands 0,07% high. Excluding a charge because the residual disappears is fitting; the IOF is a real charge on the card and belongs in the bill. It stays in, and the 4,08 is recorded here as the cost of that choice.

## Question 4 — staleness is reportable from data already in hand

`accountUpdatedAt − max(local_date)` is the whole signal, and `TransactionStore.dataThrough` at `src/core/contracts.ts:136` already computes the second half. Any transaction-derived figure ships with it.

## Decisions taken on this evidence

- **`getBillSummary` returns two named figures, not one number behind a selector.** `posted` and `committed` mean the same thing on every account and are computed by one formula with no per-card branch. A single headline number would require detecting which derivation to trust, and a detection rule that silently picks wrong is precisely the confidently-wrong-number failure `docs/prd.md:30` forbids.
- **`manageClosingDate` ships as three verbs** — `listClosingDates`, `setClosingDate`, `deleteClosingDate` — closing `docs/prd.md:109`. `setClosingDate` is an upsert, which is what the SQL does anyway.
- **Phase 6 follows Phase 4 rather than merging into it.** It inherits `billForecastDate`, the open-cycle identification and this capture, and it owns the plan key as its central problem — where a per-plan confidence flag is a natural output, unlike a single bill total.

## What Phase 4 has to carry into code

`billForecastDate` reaches neither `core/transaction.ts` nor the cache schema today, and both figures depend on it: a Zod field in `pluggy/wire.ts`, a line in `cardDetails` at `pluggy/transaction-mapper.ts:92`, a field on `Transaction`, and cache migration 3. `card_closing_day` does not exist either — `DATA_MIGRATIONS` stops at 1.

One sign trap worth a docblock. `Transaction.amountCents` on `CREDIT` is already negated, so a purchase is negative (`pluggy/transaction-mapper.ts:22-31`), while `account.amountCents` on a card is the used limit and is positive. `core/bill.ts` works in bill sign, where a purchase increases the bill, and converts once at the boundary. Mixing them does not produce a meaningless number; it produces a plausible one.

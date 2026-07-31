# [BE] listInstalmentPlans — expose open instalment plans over MCP

**Type:** Story
**Priority:** High
**Tracker:** none (local markdown)
**Size:** 2–3 days

**Superseded in part by** `docs/plans/2026-07-30-instalment-plans-design.md`. That design was written against a second read of the cache and it overrides the Design section below wherever the two disagree, in particular the plan identity key and the reversal rule. The appendix here is still the field evidence both documents rest on.

## Goal

Let an agent answer "what am I still paying off, and when does it end" in one tool call, without touching the database.

## Context

"Liste minhas compras parceladas e quando terminam de pagar" is one of the most natural questions to ask a Brazilian finance server, and the MCP surface cannot answer it today. `instalment_number`, `instalment_total` and `purchase_date` are all cached and populated, but the only tool that emits them is `getTransactionDetails`, which caps at 20 ids and needs those ids up front. `listTransactions` drops the fields entirely, so there is no way to *find* an instalment row without already knowing which row to ask about.

Answering the question in practice meant querying `cache.db` with SQL directly. The cache holds 60 plans across 115 instalment rows inside 1741 transactions, spread over twelve months and three cards. Finding them blind through the MCP surface means paging every transaction (~18 `listTransactions` calls) and then detailing all of them to see which carry the field (~88 `getTransactionDetails` calls at the 20-id cap), and it would still silently miss any plan whose purchase predates whatever window was guessed at. An agent that cannot see a plan cannot warn about it, so a R$ 2.999,00 commitment running to May 2027 is invisible to every tool we ship.

Most of the derivation already exists. `deriveImpliedCents` in `src/core/bill-rows.ts` groups rows into plans and computes the unposted tail, but it is private, scoped to a single card's open cycle, and shaped to serve the `getBillSummary` committed figure. `TransactionStore.cardRows()` (`src/core/contracts.ts`) already returns every cached row for a card unbounded by date, which is exactly the read this needs.

## Design

### New core module: `src/core/instalment-plans.ts`

Pure, no I/O, testable in `tests/core/`. Exported shape:

```ts
export type InstalmentPlan = {
  readonly accountId: string;
  readonly merchant: string;          // normalized description
  readonly purchaseDate: string | null;
  readonly instalmentCents: number;   // per-instalment amount
  readonly instalmentsTotal: number;
  readonly instalmentsPaid: number;
  readonly instalmentsRemaining: number;
  readonly remainingCents: number;
  readonly finalCycle: string;        // "2027-05"
  readonly finalCycleSource: "reported" | "derived";
  readonly reversed: boolean;
};

export function deriveInstalmentPlans(
  rows: readonly DerivedTransaction[],
  openCycle: string,
  openBillId: string | null,
): readonly InstalmentPlan[];
```

A plan is **open** when `instalmentsPaid < instalmentsTotal`. Closed plans are dropped.

### Plan identity (the crux)

The feed has no plan id, and the three obvious keys each fail differently. Use:

```
key = accountId | normalizedDescription | instalmentTotal | purchaseDate
```

where `normalizedDescription` strips a trailing ` N/M` counter, collapses runs of whitespace, and uppercases. `purchaseDate` is stable across every instalment of one plan where the feed supplies it (verified: `Amazon Prime` rows all carry `2025-12-25`; `SKY OTICA` all carry `2025-09-24`).

Deliberately **not** part of the key:

- **Amount**, because the final instalment routinely drifts by one centavo (`PUCMINAS` 361,70 then 361,69), which would split one plan into two. Take `instalmentCents` from the highest-numbered row instead, matching what `addToOpenCyclePlans` already does.
- **Raw description**, because Nubank embeds the counter in it (`Amazon Prime 6/12` then `AMAZON PRIME BR 7/12`), which splits one plan across an apparent rename.

When `purchaseDate` is null, fall back to the wrapped-counter heuristic already implemented in `trackInstalmentHistory` (`bill-rows.ts:160`): a counter that restarts after the same description completed begins a new plan. That function's documented false positive carries over, and is the right tradeoff to keep.

### Paid vs remaining

An instalment counts as **paid** only when its row is attached to a closed bill: `billId !== null && billId !== openBillId`. Rows in the open cycle and future-dated rows count as remaining. Getting this wrong is not cosmetic: `AMAZON BR` 1/10 is posted but unbilled, so the honest answer is ten instalments outstanding, not nine.

Reuse `identifyOpenCycle` (`src/core/bill.ts`) and `partitionBillRows` (`src/core/bill-rows.ts`) rather than re-deriving the open cycle.

### Final cycle

Instalment *k* lands on the *k*-th bill. Compute `finalCycle` as the cycle of the highest posted instalment, advanced by `instalmentsTotal - highestInstalmentNumber` months.

Set `finalCycleSource` to `"reported"` when the feed has materialized a row for the final instalment, and `"derived"` otherwise. Banks differ here and the distinction has to survive to the wire: Nubank publishes upcoming rows (9/12 through 12/12 were already dated ahead), Santander publishes each instalment only once its bill closes. A derived cycle is a projection from observed cadence and must never be presented as reported by the bank.

### Reversals

A charged-then-refunded plan still looks open if only debit rows are grouped. An `Araujo Loja` plan of 874,50 in 2x was reversed by a single `+1749.00` credit that carries **no** instalment metadata, so it will not share the plan key.

Match credits on the same account and normalized merchant, within the plan's cycle range, against the plan's debit total. On a full offset set `reversed: true`. Keep reversed plans in the response but exclude them from `totals` — flagging is safer than silently dropping, and it is testable in a way a heuristic deletion is not.

## Tool contract

Register `registerListInstalmentPlans` in the `REGISTRARS` array in `src/mcp/server.ts:35`. Description follows the three-part template from CLAUDE.md:

```
Lists credit card purchases still being paid in instalments.

Use this tool when:
- The user asks what they are still paying off, or when a purchase finishes.
- You need committed future spending before judging whether a new purchase fits.
- You need to explain why a card's used credit exceeds its current bill.

Returns: One entry per open plan with the merchant, per-instalment amount,
instalments paid and remaining, the money still owed, and the cycle the last
instalment lands on. That cycle is marked `reported` when the bank published the
remaining rows and `derived` when it was projected from cadence.
```

**Input:** all fields optional. `accountId` to scope to one card, `connectionId` to scope to one connection. Validate with Zod at the boundary. No date range: a plan is defined by its own span, not by a window.

**Output:** our shape, never Pluggy's envelope. Money as decimal strings via `toDecimal` (`src/mcp/format.ts:1`); integer cents everywhere inside. Serialize through `textResult`, which prunes only null/undefined, so a zero remaining total survives.

```json
{
  "plans": [{
    "card": "AADVANTAGE MASTERCARD PLATINUM",
    "accountId": "cca6e1a8-…",
    "merchant": "AIRBNB * HMJNKQKKPE",
    "purchaseDate": "2026-06-28",
    "instalmentAmount": "407.50",
    "instalmentsPaid": 1,
    "instalmentsTotal": 2,
    "instalmentsRemaining": 1,
    "remainingTotal": "407.50",
    "finalCycle": "2026-08",
    "finalCycleSource": "derived"
  }],
  "totals": { "planCount": 9, "remaining": "5853.07" },
  "dataThrough": [{ "connectionId": "…", "through": "2026-07-23" }],
  "unavailable": []
}
```

Sort by `finalCycle` ascending, then by `remainingTotal` descending. Carry `dataThrough` through, since a stale feed silently understates plans. An unreachable connection returns readable content with an explicit notice, not a protocol error.

## Files to touch

- `src/core/instalment-plans.ts` (new) — derivation
- `src/core/bill-rows.ts`: not touched. This ticket neither forks nor consumes `deriveImpliedCents`; ticket 03 unifies them.
- `src/mcp/tools/instalment-plans.ts` (new) — tool, following the structure of `src/mcp/tools/bill-summary.ts`
- `src/mcp/server.ts` — add to `REGISTRARS`
- `tests/core/instalment-plans.test.ts`, `tests/mcp/` (new)

## Test plan

TDD, red before green. Prefer table tests: one array of cases, one loop, one assertion body.

Fixtures for each trap, built by hand in `tests/fixtures/` — the repo is public, so never commit real statements:

1. Centavo drift on the final instalment stays one plan.
2. Counter embedded in the description (`Amazon Prime 6/12` → `AMAZON PRIME BR 7/12`) stays one plan.
3. Reused description after completion starts a second plan.
4. Row in the open cycle counts as remaining, not paid.
5. Future-dated final row yields `finalCycleSource: "reported"`; its absence yields `"derived"`.
6. Fully refunded plan is flagged `reversed` and excluded from `totals`.
7. A completed plan does not appear at all.

Every tool parameter needs a test proving it reaches the request: `accountId` and `connectionId` must each be shown to filter. Run `npm run mutation` afterwards and read the survivors, since `src/core/` is in Stryker's scope.

## Validation

`npm run typecheck` → `npm run lint` → `npm run deps` → `npm test`, in that order.

## Acceptance Criteria

* `listInstalmentPlans` returns every credit-card plan whose instalments paid is below its total, across all cards and all cached history, in a single call with no date range. Settled and reversed plans appear only under `includeSettled`.
* An instalment sitting in the open cycle is reported as remaining, not paid, and the money still owed is returned as a decimal string.
* One plan survives centavo drift and a rename mid-plan; two merchants sharing a card, a day and an instalment count stay two plans; a counter that restarts under a reused description produces two plans, the second flagged `renewal`.
* `finalCycleSource` is `reported` only when the bank published the remaining rows, `derived` when projected from cadence, and `unknown` on a card whose open cycle cannot be identified, where `finalCycle` is null and the notice names `setClosingDay`.
* A plan whose every materialized position is offset by a credit is flagged `reversed` and left out of `totals`; a plan with only some positions offset keeps its identity and its status, drops those positions from paid, remaining and both totals, and produces an adjustment note. A refund carrying no instalment metadata leaves a same-merchant plan untouched.
* `purchaseTotal` is summed from the observed rows plus the unposted tail, so it survives a final instalment that drifts by a centavo.
* The new derivation does not fork `deriveImpliedCents`. It leaves that function untouched and does not consume it. Unifying the two is ticket 03, deliberately kept out of this change because it moves a money figure `getBillSummary` already reports.

---

# Appendix: field evidence

Everything below was read out of a real `cache.db` on 2026-07-27. It is the ground truth the implementation should reproduce, and the source of every trap listed above. Figures are from the feed as cached; the bank app is the only oracle that confirms them.

## How to reproduce

`node:sqlite` needs Node 24, so `nvm use` first — Node 18 fails with `ERR_UNKNOWN_BUILTIN_MODULE`.

```bash
source ~/.nvm/nvm.sh && nvm use && node -e "
const {DatabaseSync} = require('node:sqlite');
const db = new DatabaseSync(process.env.HOME + '/.cache/cata-centavo/cache.db', {readOnly:true});
for (const r of db.prepare(\`
  SELECT account_id, local_date, purchase_date, description, amount_cents,
         instalment_number, instalment_total, bill_id
  FROM transactions WHERE instalment_total IS NOT NULL
  ORDER BY purchase_date, description, instalment_number\`).all())
  console.log(r.local_date, r.instalment_number+'/'+r.instalment_total,
              (r.amount_cents/100).toFixed(2), r.description, r.bill_id);
"
```

Cache state at the time: 1741 rows spanning `2025-07-15` → `2026-11-25` (the tail is future-dated instalments), 115 of them carrying instalment metadata, across 6 accounts. Feed coverage: Santander through `2026-07-23`, Nubank `2026-07-24`, MeuPluggy `2026-07-14`.

## Expected output — open plans

Ten open plans. This is the list the tool should return for this cache, and makes a good end-to-end fixture.

| Card | Merchant | Purchased | Per instalment | Paid | Remaining | Money left | Final cycle | Source |
|---|---|---|---|---|---|---|---|---|
| Santander | Araujo Loja | 2026-05-28 | 1166,00 | 2/3 | 1 | 1166,00 | 2026-08 | derived |
| Santander | MP *VISAMUNDO | 2026-05-13 | 195,68 | 2/3 | 1 | 195,68 | 2026-08 | derived |
| Santander | Vindi *CalcadosTofani | 2026-05-18 | 131,24 | 2/3 | 1 | 131,24 | 2026-08 | derived |
| Santander | AIRBNB * HMJNKQKKPE | 2026-06-28 | 407,50 | 1/2 | 1 | 407,50 | 2026-08 | derived |
| Santander | AIRBNB * HMNMZ2XMJF | 2026-06-26 | 245,50 | 1/2 | 1 | 245,50 | 2026-08 | derived |
| Santander | GPA BAR E RESTAURANTE | 2026-06-18 | 262,15 | 1/2 | 1 | 262,15 | 2026-08 | derived |
| Santander | PAGUEMENOS01232 | 2026-07-21 | 62,45 | 0/2 | 2 | 124,90 | 2026-09 | derived |
| Santander | AMAZON BR | 2026-07-18 | 299,90 | 0/10 | 10 | 2999,00 | 2027-05 | derived |
| MeuPluggy | CP PARC DUO GOURMET | 2026-07-03 | 265,50 | 1/2 | 1 | 265,50 | 2026-08 | **reported** |
| Nubank gold | AMAZON PRIME BR | 2025-12-25 | 13,90 | 8/12 | 4 | 55,60 | 2026-11 | **reported** |

Total still owed: **R$ 5.853,07**. Note the two zero-paid rows: `PAGUEMENOS01232` and `AMAZON BR` both have a `1/N` row posted, but it sits in the open cycle, so nothing has been billed yet.

Separately, `ANUIDADE DIFERENCIADA` (R$ 55,00, at 5/12, R$ 385,00 left, ends 2027-02) is the card annual fee, not a purchase. It behaves identically and should come back from the same derivation; whether the tool labels or filters it is an open question below.

## Evidence: instalment *k* lands on the *k*-th bill

Santander bill windows, by `bill_id`, showing each bill closing around the 8th:

```
2026-04-07 -> 2026-05-08 | 2bcc776c
2026-05-08 -> 2026-06-08 | 14cf4936
2026-05-13 -> 2026-07-08 | 48c42481
2026-07-09 -> 2026-07-23 | (bill_id NULL — open cycle)
```

`MP *VISAMUNDO` 1/3 sits on `14cf4936`, 2/3 on `48c42481`. So 3/3 lands on the next bill, closing ~2026-08-08. The same holds for `Vindi *CalcadosTofani` and `Araujo Loja`. Confirmed against completed plans: `SKY OTICA` ran 1/3 on 2025-09-24, 2/3 on 2025-10-08, 3/3 on 2025-11-10.

This cadence is why the end months above are `derived` — Santander never publishes the remaining rows. Do not present a derived cycle as if the bank reported it.

## Evidence: the four grouping traps

**1. Centavo drift on the final instalment.** Grouping on amount splits these into two plans each:

```
2025-09-21  1/2  -361.70  PUCMINAS
2025-10-08  2/2  -361.69  PUCMINAS
2025-12-21  1/3   -97.63  AIRBNB * HMJT5CKK2B
2026-01-08  2/3   -97.63  AIRBNB * HMJT5CKK2B
2026-02-09  3/3   -97.61  AIRBNB * HMJT5CKK2B
```

**2. Counter embedded in the description.** Nubank renames mid-plan; all twelve rows share `purchase_date = 2025-12-25`:

```
2025-12-25   1/12  Amazon Prime 1/12
…
2026-05-08   6/12  Amazon Prime 6/12
2026-06-08   7/12  AMAZON PRIME BR 7/12       <- same plan, different merchant string
…
2026-11-25  12/12  AMAZON PRIME BR 12/12      <- future-dated, hence "reported"
```

**3. Counter restarting under a reused description.** The annual fee completes and immediately begins again. Two plans, one description, no gap:

```
2026-02-09  12/12  -55.00  ANUIDADE DIFERENCIADA
2026-03-09   1/12  -55.00  ANUIDADE DIFERENCIADA
```

**4. Reversal with no instalment metadata on the credit.** All the `Araujo Loja` rows:

```
2026-05-27  +1749.00  null/null  48c42481   <- the refund, 2 x 874.50, no counter
2026-05-27   +874.50       1/2   14cf4936
2026-05-28   -874.50       1/2   14cf4936
2026-05-28   -874.50  null/null  48c42481
2026-05-28   -874.50  null/null  48c42481
2026-05-28  -1166.00       1/3   14cf4936   <- a different, still-live plan
2026-06-08  -1166.00       2/3   48c42481
```

The 874,50 plan nets to exactly zero and must be flagged `reversed`. The 1166,00 plan on the same merchant, same day, must survive untouched.

**4b. A refund that must NOT reverse a plan.** `GPA BAR E RESTAURANTE` has both a plan and an unrelated refunded charge:

```
2026-06-18  -507.56  null/null   <- one-off charge
2026-06-18  -262.15       1/2    <- the real plan
2026-07-05  +507.56  null/null   <- refunds the one-off, NOT the plan
```

Naive merchant-level credit matching flags the 262,15 plan as reversed and drops R$ 262,15 from the total. The offset has to be matched against the plan's own debits, not against everything sharing the merchant name.

## Per-bank feed behaviour

| | Publishes future instalment rows? | Instalment row dating |
|---|---|---|
| Santander (`cca6e1a8`) | No | 1/N at purchase date; later ones dated on the bill close |
| Nubank gold (`c2f080cb`) | Yes | future rows dated ahead (25/ago … 25/nov) |
| MeuPluggy (`6115b6de`) | Yes | 2/2 already dated 2026-08-03 |

Any assumption that one bank's shape generalizes will produce wrong end dates for the others. `usedCredit` on the Santander card was R$ 9.276,79 against R$ 5.916,97 of uncharged instalments — consistent with the tool docs describing used credit as mixing the open cycle with instalments not yet charged, and a rough cross-check on the derivation rather than a proof of it.

## Open questions

All three are resolved in `docs/plans/2026-07-30-instalment-plans-design.md`, kept here for the reasoning that led to them.

- **Annual fee**: flagged, not filtered. It falls out of the second identity pass for free and carries `renewal: true`.
- **Plans on a card with no closing day configured**: returned, counted conservatively, with a null `finalCycle` and a notice naming `setClosingDay`.
- **Centavo rounding in `remainingTotal`**: accepted and stated in the tool description.

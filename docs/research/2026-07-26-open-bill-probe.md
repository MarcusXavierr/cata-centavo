# The open bill, probed against real cards — 2026-07-26

Read-only capture against three connections on connector 200, taken while diagnosing why `getAccounts` reported a credit card's utilization as its bill. Endpoints hit: `GET /accounts/{id}`, `GET /bills?accountId=`, `GET /v2/transactions?accountId=`. No real statement amounts belonging to third parties appear here; the figures are the author's own and are the point of the document.

The labelling fix that came out of this is `docs/plans/2026-07-26-credit-utilization-not-a-bill.md`. **This file is the part that outlives it**: what the open bill actually is, why it is not computable yet, and what Phase 4 needs to know before writing `getBills`.

## The two numbers to beat

Open bill (cycle in progress, due 15/08), read from the bank apps on 2026-07-26:

| card | account id | open bill |
| --- | --- | ---: |
| AAdvantage Mastercard Platinum (Santander) | `cca6e1a8` | **R$ 6.042,44** |
| gold (Nubank) | `c2f080cb` | **R$ 42,92** |

Validate any implementation against these two *before* shipping it. They are worth more than any synthetic fixture, because they are the only independent oracle this project has.

## Settled: `account.balance` is the used limit

On an Open Finance connector, a credit card's `balance` is the portion of the limit taken at request time. `disaggregatedCreditLimits` confirms it exactly — the Platinum's `CREDITO_A_VISTA` line carries `usedAmount: 9170.89`, identical to `balance`; the gold's carries `usedAmount: 98.52`.

`docs/adr/0001-stack-and-architecture.md:580` had already written it down: *"on `CREDIT` it is the open unpaid bill — and on regulated Open Finance connectors, the used limit."* All three connections are connector 200, so it is always the second case.

Note also that one account object straddles two periods: `balance` is now, while `creditData.balanceDueDate` (`2026-07-15`) and `creditData.minimumPayment` (`1304.66`, identical to the 15/07 bill's `minimumPaymentAmount`) describe the last closed cycle.

## The model

One identity explains both cards:

```
utilization (account.balance) = open bill + instalments not yet charged
```

The gold confirms it exactly: `98,52 − 55,60 = 42,92`, where 55,60 is the four AMAZON PRIME instalments scheduled for cycles 2026-09 through 2026-12. The Santander requires `9.170,89 − 3.128,45 = 6.042,44`.

## Why it is not computable yet

**Computing "instalments not yet charged" is the blocker, and the two cards do it in opposite ways.** `docs/prd.md:93` predicted this for Phase 6: *"one posts several instalments of a purchase at once, the other one per bill."* It turns out to block Phase 4 too.

- **The gold materializes** future instalments as transaction rows carrying a future `billForecastDate`. Summing those rows gives 55,60. The implied remainder via `(totalInstallments − installmentNumber)` is zero, because a 12/12 row already exists.
- **The Santander does not materialize** them: `AMAZON BR 1/10` from 18/07 exists once, with nine instalments implied. Worse, **there is no stable key to group a payment plan.** `creditCardMetadata.purchaseDate` is filled per instalment rather than per purchase, so the 12× annual fee appears as twelve distinct "plans" and any implied-remainder sum inflates — R$ 9.612,81 against the R$ 3.128,45 the identity requires. The description is not a key either: on the gold it embeds the counter (`"AMAZON PRIME BR 8/12"`).

Approaching from the transaction side inverts the asymmetry, and neither side covers both cards.

- **The Santander closes on transactions**, with one term nobody has explained: `6.510,11` (unbilled purchases) − `62,45` (the 2/2 instalment carrying `billForecastDate: "0001-01"`, a future cycle) − `401,14` (a MAXMILHAS credit) − `4,08` (IOF) = `6.042,44` exactly. The −13.046,61 `PAGAMENTO DE FATURA` on 14/07 stays out, since it settles the closed bill. **Three terms fitted against a known target is fitting, not a rule.** Treat it as a lead.
- **The gold does not close on transactions**: it gives R$ 23,90 (the two `fc=2026-08` rows), missing R$ 19,02. This is not a missing refund — the gold has 13 credits in its history (`Crédito de atraso`, `Encerramento de dívida`, −1.037,32 total), just none in the open cycle. **Its transaction feed stops at 08/07** with no purchase since, while the account itself was updated 2026-07-26 19:39. Utilization is fresher than the statement.

The gold's transactions do not reconcile with its own bills either: cycle 2026-06 sums to R$ 704,24 of purchases against a `bill.totalAmount` of R$ 1.602,36.

## Hypotheses tested and rejected

| hypothesis | Santander (target 6.042,44) | gold (target 42,92) |
| --- | ---: | ---: |
| `account.balance` | 9.170,89 | 98,52 |
| `bills[0].totalAmount` (closed cycle, 15/07) | 13.046,61 | 307,89 |
| net sum of transactions on the 15/07 `billId` | 6.569,99 | −1.711,19 |
| purchases only, 15/07 `billId` | 15.081,46 | 199,06 |
| purchases only, open cycle, no adjustments | 6.510,11 | 23,90 |
| `balance` − materialized future instalments | not derivable | **42,92** ✓ |
| open-cycle purchases − future instalment − credits − IOF | **6.042,44** ✓ | 23,90 |

Two exact hits, by different routes, neither of which generalizes. That is the finding.

## Open questions Phase 4 has to answer

1. **How do you identify a payment plan on the Santander**, when `purchaseDate` is per-instalment and the description is not a key? Candidates not yet tried: whether `GET /bills/{id}` carries the bill's composition, and whether the instalments product (Phase 6) exposes the plan directly. If it does, Phase 6 may have to precede Phase 4 — worth checking before committing to the roadmap order.
2. **Can the posting style be detected from the data**, or does it become per-account configuration? Detecting it means asking "does this connector emit rows for cycles that have not closed yet", which is answerable per account but needs a rule for the case where a card simply has no active instalments.
3. **Why does the IOF leave the Santander's open bill?** R$ 4,08 on 10/07, described `IOF DESPESA NO EXTERIOR`. Either the app charges it to the following cycle, or the exact match is coincidence.
4. **How do you report staleness?** The gold's statement trails its utilization by 18 days. Any transaction-derived figure must state where its data stops, or it hands back a stale number wearing a current one's face.

## API surface, as observed

- **`GET /bills?accountId=`** returns closed cycles only, newest first — 12 on both real cards. Fields: `dueDate`, `billClosingDate`, `totalAmount`, `totalAmountCurrencyCode`, `minimumPaymentAmount`, `allowsInstallments`, `financeCharges[]`, `payments[]`. **There is no month filter**; selection is client-side.
- **Bill N's `payments` settles bill N−1.** The 15/07 bill carries a `FULL_PAYMENT` of 6.254,89 dated 12/06, exactly the 15/06 bill's `totalAmount`. Pluggy documents the check as `totalAmount(Bill N) + sum(financeCharges(Bill N+1)) = sum(payments(Bill N+1))`.
- **The open cycle is absent from `/bills`.** August exists as no record on either real card. Only the sandbox card has a future bill. So `/bills` is a ledger of closed statements, and the naive "nearest future `dueDate`" heuristic returns nothing on real data.
- **`GET /v2/transactions?accountId=`** paginates by cursor. `next` comes back as a **relative query string** (`?accountId=…&after=…`), not an absolute URL — concatenate it onto the base path. **`pageSize` is rejected with a 400** (`property pageSize should not exist`). `GET /transactions` is gone (410), per `docs/research/2026-07-26-phase-0-5-recon.md`.
- **`creditCardMetadata`** carries `cardNumber`, `payeeMCC`, `billForecastDate`, `purchaseDate`, `totalInstallments`, `installmentNumber`, `billId`, `feeType`, `feeTypeAdditionalInfo`. A transaction with no `billId` has not been billed yet.
- **`billForecastDate` emits a sentinel**: instalments with no cycle assigned come back as `"0001-01"`. It is also unreliable on the Santander, which stamps `2026-07` on purchases made after the 15/07 cycle closed on 08/07.
- **Compare `dueDate` on its UTC parts.** The real connector sends `00:00:00.000Z` and the sandbox `03:00:00.000Z`; in UTC−3, UTC midnight falls on the previous day, so a bill due on the 1st lands in the wrong month.
- **Nubank sends four decimals** (`307.8891`, `56.8248`, `2001.4809`). `toCents` at `src/pluggy/mapper.ts:67` already rounds half-away-from-zero over the decimal representation without touching binary floats. Reuse it.
- **`customizedLimitAmount` explains a limit that looks wrong.** The gold reports `creditLimit: 5450` and `availableCreditLimit: 2001.48`, which contradict a utilization of 98,52 — until you find `customizedLimitAmount: 2100` in `disaggregatedCreditLimits`, and 2100 − 98,52 = 2001,48. The real payload carries 20 such lines including per-modality ones, so filter on `creditLineLimitType === "LIMITE_CREDITO_TOTAL"`.

## Cost of building it, measured

The `Bank` contract at `src/core/contracts.ts:87-96` has four methods and gains a fifth. `src/core/bill.ts` is a new file already anticipated in the ADR's layout (`docs/adr/0001-stack-and-architecture.md:171`). Bills paginate on the same `total`/`totalPages`/`results` envelope that `src/pluggy/client.ts:47-63` already walks, so the pagination is a copy. The seven test files that use `tests/fakes/fake-bank.ts` do not break as long as the fake supplies a default for the new method. Three credit cards means three extra requests, and rate limiting already lives inside the single send function. `docs/adr/0001-stack-and-architecture.md:298` notes bills refresh once per day regardless of item updates, so caching them is cheap and worth it.

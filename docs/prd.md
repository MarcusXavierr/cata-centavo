# PRD — cata-centavo

Last revised: 2026-07-27, after the Phase 4 live acceptance run.

This document says **what we are building and what "done" means in the user's words.** `docs/adr/0001-stack-and-architecture.md` says how, and wins on every engineering question. Where this document and the ADR disagree about scope, this one is newer — the recon of 2026-07-26 invalidated several of the ADR's premises, and the amendments have not landed yet. `docs/research/2026-07-26-phase-0-5-recon.md` is the evidence.

## Who this is for

The author first. Technically-minded friends second. A portfolio piece third, and only third.

Setup is not friendly and is not going to become friendly: you link each bank inside MeuPluggy by hand, copy a UUID out of their dashboard, and paste it into an environment variable. Nobody's non-technical relative is getting through that. Pluggy gives us no way to list connections and no webhook to catch a new one (ADR §2), so this is the floor, not a backlog item.

What that buys: the whole thing runs locally, reads your own accounts, and costs nothing.

## The job

You have several banks and cards. You want to ask an agent about your own money in your own words and get an answer you can act on.

- "Quanto gastei com mercado em junho?"
- "Qual o total da minha fatura aberta do Nubank?"
- "Quanto ainda falta pagar de parcelas?"
- "Tô gastando mais com delivery esse mês do que no passado?"

The agent answers by calling our tools. Our job is that the numbers underneath are right.

## What "right" means

This is the bar, and it is the part of this document worth arguing about. Every item is a failure we have either seen in the prior Go implementation, found in the ADR's own assumptions, or reproduced ourselves during the recon.

**1. Never a confidently wrong number.** A tool that errors is recoverable. A tool that returns a plausible wrong total is not, because nobody checks. The known ways to violate this:

- Summing `amount` across `BANK` and `CREDIT`. The sign convention inverts between them — on a checking account a debit is negative, on a card a debit is positive — so a mixed `SUM` does not merely mean nothing, it **partially cancels** and lands on a believable figure.
- Summing across currencies. Pluggy already did the conversion and parks it in `amountInAccountCurrency`; the rule is `amountInAccountCurrency ?? amount` and forgetting it silently adds dollars to reais.
- Stopping pagination early. `GET /v2/transactions` is cursor-based and reports no total, so nothing tells you the page was not the last one. We hit this during the recon itself: a mis-joined cursor stopped at 500 rows on an account holding 1053, with no error.
- Reporting an empty result as "you spent nothing" when the real cause is a revoked consent.
- Letting a balance of exactly `0` vanish in serialization, or money pass through a JS `number`.

**2. Aggregates cover the whole range, or the tool fails loudly.** Partial coverage is never reported as a total.

**3. Every declared tool parameter actually reaches the request.** The prior implementation shipped a filter that was parsed, validated, and never read.

**4. The model can recover from what it should recover from.** A revoked consent, an unknown connection, a legitimately empty bill list — all readable tool content, never a protocol error the model cannot see.

**5. Nothing but JSON-RPC on stdout.** Every diagnostic goes to stderr.

## Non-goals

| Not doing | Why |
|---|---|
| Currency display and conversion | Pluggy converts already; only presentation is open. **V3** |
| Automatic LLM categorization | Cut. Someone has to ask; the agent then reads uncategorized rows and writes back |
| Rules engine over description text | Deferred. Whether it is ever needed is a measured number — see below |
| Forcing a bank refresh | Connector 200 refuses `PATCH /items/{id}` unconditionally. Removed, not deferred |
| Listing connections you did not configure | Impossible. Pluggy has no item listing, by design |
| Payment initiation, HTTP transport, webhooks | Out of scope for a local single-user server |
| Encrypting the cache | Needs SQLCipher, which `node:sqlite` does not have. The README states the posture instead |

## What the recon changed

Three findings reorganize the roadmap.

**Categorization is dormant, not needed.** The ADR builds §12 on "the free tier returns `category: null`". On this account, 99.7% of transactions arrive categorized, because the account is not on the free tier yet. So the derivation machinery is not surplus — it is the contingency for when enrichment goes away. We have pre-built the fallback rather than waiting: `src/core/mcc.ts` maps 87 MCC codes to categories, derived from 1123 card transactions that carried both.

**We already have the number Phase 3 existed to produce.** The ADR says Phase 3 answers "what fraction is still uncategorized after override, counterparty and MCC — that residue decides whether V2 rules are urgent or optional". Measured, before writing Phase 3: **14.8%** (259 of 1751). Cards keep MCC on 88.7% of rows; checking accounts keep a CPF/CNPJ on 76.1%; the two halves fail for different reasons and neither mechanism reaches the other. If 14.8% is tolerable, V2 never has to exist.

**The taxonomy question is closed.** Pluggy serves 130 bilingual categories from `GET /categories`. We adopt the **22 top-level groups**, rolling children up through `parentId` — transitively, since the tree is three levels deep in places, and never by slicing the id, since four entries use nine digits where the rest use eight.

## Phases

Each ships something usable and answers a question the next one needs.

**Phase 0 — foundations.** Done. Environment-only config, XDG paths, `parseArgs` dispatch, both SQLite files with a migration runner, and an `init` that validates every configured connection and reports per id.
*Acceptance:* you install, export three variables, run `init`, and it tells you which banks are reachable and which are not, without stopping at the first bad one.

**Phase 0.5 — reconnaissance.** Mostly done. Five of seven questions answered against real accounts.
*Still open:* whether a transaction id survives a re-sync, and whether the general rate limit is per minute or per hour.

**Phase 1 — accounts and balances.** `getAccounts`, `getBalance`, `getBalanceByAccount`, the lazy cache and the `Clock`.
*Acceptance:* "quanto eu tenho?" returns cash only, with invested and owed as separate labelled figures, and never a single number that folded a credit card bill into your checking balance.

**Phase 2 — transactions.** Done. `getTransactions` returns aggregates with capped `sampleIds`, `listTransactions` is paged with a hard cap of 100, and `getTransactionDetails` is a separate bounded lookup. Description normalization lands here.
*Acceptance:* Live acceptance covered all six accounts. The June aggregate loaded every cursor page, returned `spent` and `received`, repeated from cache without another walk, and kept card-bill transfers out of the headline totals. Category filtering, bounded listing, detail lookup and the over-cap refusal also passed.

**Phase 3 — categories.** Done. Not "add categorization" but "keep it once the provider stops sending it": the plan drops to free in roughly fifteen days and the enrichment goes with it, and because a walk overwrites every cached row, what disappears is the history, not just the future. So the enrichment is harvested into `data.db` — which is never dropped — on every walk, and reads resolve override → manual counterparty → live Pluggy → harvested Pluggy → learned CNPJ → MCC in one query across both files. The taxonomy ships as code rather than seeded, which also removes a per-read call to `GET /categories`.
*Acceptance:* "quanto gastei com mercado?" works, and correcting one transaction sticks. Correcting a merchant by CPF/CNPJ applies backwards over everything they already sold you. **And the one that proves the phase did its job without waiting for the tier to change:** replay the same wallet with every `category` nulled, as though the window had already closed — every aggregate, group total and filtered query returns identical numbers, and only `categorySrc` moves. `tests/storage/tier-change.test.ts`.

**Phase 4 — credit cards.** Done. `getBills`, `getBillSummary`, `listClosingDays`, `setClosingDay`, `deleteClosingDay`.
*Acceptance:* "qual minha fatura aberta?" returns `posted`, `committed` and the gap between them, each with the date its transaction data stops at. One number cannot be made trustworthy across both live posting styles: delayed rows pull `posted` down, while missing or ambiguous instalment data can move `committed` independently. The tool therefore names both measurements and reports their disagreement instead of choosing one behind a hidden rule. Empty bills remain a normal result. None of the current live cards had an empty list, so that case is automated acceptance rather than claimed live evidence.
**Evidence:** `docs/research/2026-07-26-phase-4-acceptance.md` records the 2026-07-27 live totals and counts. `docs/research/2026-07-26-phase-4-open-bill-derivation.md` records why the two-figure contract replaced the original one-number target.

**Phase 5 — observability.** `listSources` only; `manualUpdate` is gone. A revoked consent becomes an explicit error rather than an empty list.
*Acceptance:* "quais bancos você enxerga?" lists them with last sync and consent state, and says plainly that a bank missing from the list is invisible to it by construction.

**Phase 6 — instalments.** `getInstallments`, last, with real data in hand. Posting behaviour differs between the author's own two cards — one posts several instalments of a purchase at once, the other one per bill — so this cannot be generalized from a single bank.
*Acceptance:* "quanto falta de parcelas?" is right on both cards, not just the one it was written against.

**Phase 7 — `doctor` and the README.** The README is a deliverable, not an afterthought, and it states the security posture in plain words: anyone who can read your files as you can read your entire financial history.

## Open decisions

Blocking, in the order they bite.

1. ~~**Cache freshness by range** — how to know whether `[from, to]` is already cached.~~ **Moved to Phase 2, 2026-07-26.** A range is a transaction concern and does not block account snapshots in Phase 1.
2. ~~**`camelCase` or `snake_case`** for tool names.~~ **Closed 2026-07-26: `camelCase`.**
3. ~~**`isError` content versus protocol error**, decided per failure class.~~ **Closed for Phase 1, 2026-07-26.** Recoverable failures use readable `isError` content per tool: listings return available accounts with unavailable connections, while aggregates refuse a partial total. Transport failures remain protocol errors.

The Phase 1 decision record and rationale are in `docs/plans/2026-07-26-phase-1-accounts-and-balances-design.md`.
4. ~~**What the `getTransactions` aggregate groups by** — category, merchant, account, month. The token budget follows from the answer.~~ **Closed 2026-07-26:** top-level category, with up to ten sample ids per group. See the Phase 2 acceptance record.
5. ~~**`manageClosingDate` as one tool with an `operation` enum, or three verbs.** *Blocks Phase 4.*~~ **Closed 2026-07-27:** three verbs, `listClosingDays`, `setClosingDay` and `deleteClosingDay`.
6. ~~**Test fixtures without committing real statements** to a public repository.~~ **Closed 2026-07-26:** fixtures use synthetic transactions and a redacted Pluggy-shaped page; the live acceptance record stores totals and counts, not statements or transaction ids.
7. **Is 14.8% uncategorized tolerable?** Answering no is the only thing that puts a rules engine back on the map.

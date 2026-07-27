# Phase 3 — categories, designed as a harvest

Date: 2026-07-26
Status: proposed

## Why this phase is not what the ADR planned

ADR §12 was written on the premise that `transaction.category` comes back `null` on the free tier, so the derivation chain — override → counterparty → MCC — is the *only* source of a category. The Phase 0.5 recon found the opposite: 1745 of 1751 rows (99.7%) arrive categorized, because the account is not on the free tier yet. §12.1's own amendment recorded that honestly and downgraded §12 from dead to dormant.

The account owner now has a date: **the plan drops to free in roughly fifteen days, and enrichment goes with it.** That turns §12 from dormant into urgent, and it changes the shape of the phase. This is not "add a fallback for future transactions". It is:

> Harvest the enrichment into storage that is never dropped, while it still exists, then serve from the harvest.

Context7 corroborates the direction without settling the date: Pluggy documents `POST /transactions/categorize` (the Enrich API) as a product of its own, taking exactly `description`, `paymentData.receiver.documentNumber` and `creditCardMetadata.payeeMCC` and returning category and merchant. The three signals we already hold are the ones they sell. What the docs do not state is which fields the free plan gates, or when. The fifteen days come from the account owner, not from a published source, and this document treats them as a deadline rather than as a verified fact.

## What "the enrichment goes away" actually costs

The damage is larger than "new rows arrive uncategorized", and this is the finding the design is built around.

`replaceAccount` (`src/storage/transactions.ts:76`) is a full replace per account. The upsert sets `category_id = excluded.category_id` (line 30) and `deleteMissing` removes any row absent from the new payload. `walkIfStale` (`src/core/transactions.ts:44`) fires that walk whenever the account's `lastUpdatedAt` differs from the stored stamp.

So on the first sync after enrichment stops, the 1745 rows that are categorized today are overwritten with `NULL`. Nothing errors. And `cache.db` is droppable by policy (ADR §10): a `user_version` mismatch drops the file and rebuilds it from a Pluggy that, by then, returns no categories at all.

**Today's 99.7% coverage is perishable, and it is the history that perishes, not just the future.**

A second, quieter dependency has the same exposure. `buildRollup` is called per read against `bank.getCategories()` (`src/mcp/tools/transactions.ts:193`, `src/mcp/tools/list-transactions.ts:85`). If `GET /categories` is gated alongside enrichment, aggregation stops working entirely — not degraded, broken.

## A bug this phase must fix by construction

`categoryInput` (`src/mcp/tools/transaction-input.ts:8`) accepts only the 22 top-level ids, via `isCategoryId`. `storage/transactions.ts:139` filters `category_id IN (...)` against the **leaf** id Pluggy wrote. The roll-up to the 22 happens only in JavaScript, in `aggregate.ts:57`.

So `getTransactions({categories: ["11000000"]})` returns only rows tagged exactly `11000000` and drops every row tagged with a child such as `11010000`, while the unfiltered call rolls those same children into the "Alimentos e bebidas" group. Two different totals for the same question, neither of them flagged. This is PRD item 1 — a confidently wrong number — and `tests/storage/transactions.test.ts:132` locks it in under the name "filters by leaf category", using a top-level id as though it were a leaf.

The fix falls out of the design rather than being bolted on: once every branch of the derivation emits one of the 22, the filter compares one vocabulary against itself.

## Decisions

### D1 — Pluggy's live category ranks above the harvest and below manual correction

Six branches, because "what Pluggy said" exists in two forms — the live one and the remembered one.

| # | Branch | Lives in | Keyed by | `category_src` |
|---|---|---|---|---|
| 1 | Manual override | `data.db` | `transaction_id` | `override` |
| 2 | Manual counterparty | `data.db` | `document` | `counterparty` |
| 3 | Pluggy, live | `cache.db` | the row itself | `pluggy` |
| 4 | Pluggy, harvested | `data.db` | `transaction_id` | `pluggy` |
| 5 | Counterparty, learned | `data.db` | `document` | `learned` |
| 6 | MCC | `cache.db` | `mcc` | `mcc` |
| — | nothing matched | — | — | `none` |

Two rules place every row of that table:

**Manual correction beats Pluggy** (2 above 3), because correcting Pluggy is the entire point of a manual tool. **The harvest loses to Pluggy** (4 and 5 below 3), because it was derived from Pluggy — letting a generalization overwrite the source that produced it is the same error as ranking the MCC map above the categories the map was derived from.

Branch 4 is not redundant with branch 3. The harvest is written inside the same transaction as the walk, so it always covers what branch 3 covers; what separates them is durability. Branch 3 lives in the droppable file and disappears on a rebuild. Branch 4 does not. Both report `category_src: "pluggy"`, because to the user they are the same answer.

### D2 — the roll-up to the 22 happens on write, in its own column

`transactions.category_id` keeps Pluggy's leaf, one of the 130. A new `transactions.top_category_id` holds the root, one of the 22, computed at insert.

The alternative — seeding the 130-entry tree into `cache.db` and joining it inside the derivation — is what the PRD's phase line describes. It is rejected because it puts a join on the hot path of every read and leaves the tree in the droppable file, which after the window closes has to be re-seeded from code anyway.

Consequence: **SQL never needs the taxonomy tree.** Filter, derivation and aggregation all read a 22-valued column.

### D3 — the 130-entry tree ships as a code constant

`buildRollup` stops being fed from the network. The tree is universal reference data, not a statement, so unlike a CNPJ map it can be committed. This removes a per-read network dependency and makes the roll-up survive the tier change.

**An unknown leaf must not kill a walk.** `taxonomy.ts` currently throws on an id absent from the tree (`rootOf`). Ship-as-code means a category Pluggy adds later is absent by definition. At write time the rule becomes: unknown leaf → `top_category_id = NULL`, keep the leaf in `category_id`, log a warning. The row falls through to branches 4–6 instead of taking a whole account's walk down with it.

### D4 — learn CNPJ, never CPF

Of the 366 documents in the wallet, **278 are CPF and 88 are CNPJ**. A CNPJ has a line of business, so "this CNPJ is Groceries" generalizes for the same reason an MCC does. A CPF is a person. Learning "CPF X → Transfers" from one PIX and then stamping it on every future transfer to your brother is a plausible wrong number, and because `setCounterpartyCategory` is retroactive by construction, the damage is retroactive too.

The two are free to tell apart: the recon confirms 11 digits on all 278 CPFs and 14 on all 88 CNPJs, and `toDigits` (`src/pluggy/transaction-mapper.ts:9`) already strips punctuation and returns `null` — never `''` — for an absent document, which satisfies §12.2's join-key requirement on the write path.

CPF stays fully usable through **manual** `setCounterpartyCategory`. It is never learned.

**Evidence threshold:** a document's winning category must hold a true majority of that document's labelled rows (`agreeing * 2 > samples`), not merely a plurality. A tie drops the mapping. `samples` and `agreeing` are stored on the row, exactly as `mcc.ts` carries them, so `doctor` can later surface a weak mapping as one.

### D5 — the learned map is personal and never leaves the machine

`src/core/mcc.ts` is universal: MCC 5411 is a supermarket for everybody, which is why it could be derived from one wallet, committed, and still work for someone who installs tomorrow having never had enrichment.

"CNPJ 12345678000190 → Groceries" is a line of somebody's statement. The repo is public and the PRD forbids committing real statements. So the CNPJ map is **learned at runtime, from the user's own cache, into the user's own `data.db`**, and no part of it is ever committed.

**Accepted consequence, and it belongs in the README:** a user who installs after their own enrichment window has closed has an empty map forever, with nothing to harvest from. They get MCC on cards and manual correction everywhere else. This is a real asymmetry between the author and a future user, and it is better written down than discovered.

### D6 — `"none"` becomes a legal value in the `categories` filter

After the window, the primary workflow is "show me what has no category so I can fix it". No tool can express that today: `categoryInput` accepts only the 22 ids, and the aggregate's null group is visible but unreachable — its `sampleIds` are capped at 10, which samples rather than works.

`categories: ["none"]` matches rows whose derivation fell through to nothing. It reuses `listTransactions`' cursor and its hard cap of 100, so a full page can be corrected with one `setCategory` call.

Rejected: a separate `categorySrc` filter (more expressive — it would allow auditing every MCC-derived row — but a second parameter to describe, test and prove reaches the request), and a dedicated `listUncategorized` tool (better discovery per §12.8, at the cost of a tenth tool duplicating filter, cursor and cap).

## Data model

```
code — universal, committed, survives everything
  src/core/mcc.ts        87 MCC codes → one of the 22        exists
  src/core/taxonomy.ts   the 130 entries, id → parentId      becomes a constant

cache.db — droppable, rebuilt from Pluggy
  transactions.category_id        Pluggy's leaf, 1 of 130, nullable
  transactions.top_category_id    the root, 1 of 22, nullable          NEW
  mcc_categories(mcc, category, samples, agreeing)                     NEW, seeded from mcc.ts

data.db — never dropped
  category_overrides(transaction_id PK, category, created_at)
  counterparty_categories(document PK, category, origin, samples, agreeing, created_at)
  category_snapshot(transaction_id PK, category_id, top_category_id, harvested_at)
```

**`counterparty_categories` is one table with an `origin` column** (`manual` | `learned`), because manual and learned share a key and a meaning. `origin` is what places a row at branch 2 or branch 5. `samples` and `agreeing` are `NULL` on manual rows. A manual write over a learned document **replaces** the row and flips `origin` to `manual`: one document, one truth.

**The snapshot stores both the leaf and the root.** The leaf because the snapshot is the last copy that will exist, and keeping `11010000` costs exactly what keeping `11000000` costs while leaving the door open to finer granularity later. The root because it makes the snapshot branch a plain column read, identical in shape to branch 3.

## The derivation query

`data.db` is `ATTACH`ed as `userdata` onto the `cache.db` connection. ADR §10 verified both that `ATTACH` works in `node:sqlite` and that it permits joins across the two files. `openDatabases` currently returns two handles that cannot see each other; that changes.

There is no `CREATE VIEW`. A view in `cache.db` referencing `userdata.` would couple the droppable file's schema to a schema name that must already be attached — including during the migration run at startup, before any attach has happened. The derivation lives as a shared SQL constant in `src/storage/category-sql.ts` instead.

Each branch is selected as its own column, and the resolution happens once in a pure function:

```sql
WITH derived AS (
  SELECT t.*,
    (SELECT o.category FROM userdata.category_overrides o
       WHERE o.transaction_id = t.id)                              AS c_override,
    (SELECT c.category FROM userdata.counterparty_categories c
       WHERE c.document = t.document AND c.origin = 'manual')      AS c_counterparty,
    t.top_category_id                                              AS c_pluggy,
    (SELECT s.top_category_id FROM userdata.category_snapshot s
       WHERE s.transaction_id = t.id)                              AS c_snapshot,
    (SELECT c.category FROM userdata.counterparty_categories c
       WHERE c.document = t.document AND c.origin = 'learned')     AS c_learned,
    (SELECT m.category FROM mcc_categories m WHERE m.mcc = t.mcc)  AS c_mcc
  FROM transactions t
  WHERE <account, date, amount and account-type filters>
)
SELECT * FROM derived
WHERE COALESCE(c_override, c_counterparty, c_pluggy, c_snapshot, c_learned, c_mcc) IN (...)
```

**One source of truth for the order.** A single exported array generates both the SQL fragment and the JS resolution, so the precedence and the reported `category_src` cannot drift apart:

```ts
const BRANCHES = ["override", "counterparty", "pluggy", "snapshot", "learned", "mcc"] as const;
```

The alternative — a `COALESCE` for the value beside a mirrored `CASE` for the source — is rejected precisely because the two drift, and when they do, `category_src` starts lying about where a number came from. In a project whose first rule is never a confidently wrong number, provenance that can silently disagree with the value is the wrong trade.

Cheap filters (account, date, amount, account type) run in the inner query so the six correlated subqueries only touch rows that survive them. Every subquery hits an indexed key: `transaction_id` and `document` are primary keys in `data.db`, `mcc` is one in `cache.db`, and `transactions(document)` gets an index.

`categories: ["none"]` becomes `COALESCE(...) IS NULL`; mixed with real ids it becomes `(COALESCE(...) IN (...) OR COALESCE(...) IS NULL)`.

A `NULL` document never joins another `NULL` document — SQLite equality on `NULL` yields `NULL`, not true — which is the failure §12.2 warns about, avoided by the type system rather than by a guard.

## The harvest

It runs inside `replaceAccount`, in the transaction that is already open, with every row already in hand. No user action, no separate command, no schedule.

**Step 1 — snapshot.** Every row with a non-null `category_id` is upserted into `userdata.category_snapshot`. Rows with a null category write nothing: the snapshot only ever gains, never loses. A later walk carrying a different category updates the row; a later walk carrying no category leaves it alone. That single asymmetry is what makes the history survive.

**Step 2 — learn.** The `(document, top_category_id)` pairs are read out for documents of exactly 14 digits, the winner per document is chosen by a pure function in `core/`, and the result is written back:

```sql
DELETE FROM userdata.counterparty_categories WHERE origin = 'learned';
INSERT INTO userdata.counterparty_categories (...) VALUES (...) ON CONFLICT(document) DO NOTHING;
```

The `DELETE` only touches learned rows, so manual ones survive untouched, and `DO NOTHING` then declines to overwrite a manual row for a document that would also have been learned. Recomputing wholesale rather than incrementally is affordable at this size — roughly two thousand rows — and it means a manual correction, a re-sync and a cache rebuild all converge on the same map instead of accumulating drift.

**The migration rebuild is the backfill.** `top_category_id` is a new column, so `cache.db` bumps its `user_version`, the file is dropped, and every account is re-walked from zero. Every row passes through `replaceAccount`. The phase's own migration therefore performs one complete pass over the whole history, and no separate backfill routine needs to exist.

That is also where the deadline bites. That pass only harvests anything while enrichment is alive. After the window, the very same rebuild becomes the event that would erase everything, and what prevents it is the snapshot already being in `data.db`. **Both migrations must ship in the same release.**

## Tools

**`setCategory({ transactionIds, category })`** — writes overrides. Caps at 100 ids, matching `listTransactions`' page size so a full page can be corrected in one call. `category` is validated against the 22. Unknown ids are reported in the response rather than raised, per PRD item 4; the known ones are still written. Returns `{ updated, unknownIds }`.

**`setCounterpartyCategory({ document, category })`** — writes one manual counterparty row. Strips punctuation, rejects an empty document, accepts 11 or 14 digits and rejects any other length. Replaces a learned row for the same document. Returns `{ document, category, affected }`, where `affected` counts the cached transactions that now resolve through it — §12.6 requires that count, for the same reason `addRule` does: a number tells both model and user when a write is broader than they meant.

**`getTransactions` / `listTransactions` / `getTransactionDetails`** — read the derived category instead of `category_id`, and expose `categorySrc`. No signature changes beyond `"none"` becoming legal in `categories`.

No unset tool. Setting a different category is the undo, and a delete verb can arrive later at no migration cost.

## Migrations

**`cache.db` → `user_version` 2.** Under the `rebuild` policy `apply` replays the chain from 0 against a dropped file, so entry 2 must be additive: `ALTER TABLE transactions ADD COLUMN top_category_id TEXT`, `CREATE TABLE mcc_categories`, `CREATE INDEX transactions_by_document`, and the 87 seed rows generated from `src/core/mcc.ts` so the constant stays the single source.

**`data.db` → `user_version` 1.** The first entry in a chain that has been empty since Phase 0. Three `CREATE TABLE`s. Policy is `migrate`, so it moves forward or refuses.

## Failure modes

| Condition | Behaviour |
|---|---|
| Pluggy sends a leaf absent from the shipped tree | `top_category_id = NULL`, leaf kept, warning logged, walk continues |
| The shipped tree has a cycle or a leaf reaching no root | Caught by a test, never at runtime |
| `data.db` unreadable or written by a newer release | `openDatabases` already refuses to start. Degrading would silently drop the user's overrides, which is worse than not starting |
| A document has two categories at exactly 50/50 | No learned mapping. The tie is not broken |
| Enrichment stops mid-range | Branch 3 goes null per row, branch 4 answers, totals do not move |

## Tests

**Pure, `tests/core/`** — every one of the 130 entries rolls up to one of the 22; an unknown leaf yields `null` rather than throwing; the shipped tree is acyclic and complete; the majority rule as a table test (unanimous, majority, exact tie, single sample); document validation across 11 digits, 14 digits, other lengths, punctuation and empty.

**`tests/storage/`, `:memory:` with both files attached** — each of the six branches wins in isolation; precedence proved pairwise down the chain; an override survives dropping `cache.db` (§12.11 asks for exactly this); filtering by a top-level id now returns rows tagged with its children, as a regression test naming the bug above; `categories: ["none"]`; two rows with `NULL` documents never join each other.

**`tests/mcp/`** — every parameter reaches the request, which is the rule `npm run mutation` exists to check; a category outside the 22 is rejected; an 8-digit document is rejected; `"none"` is accepted.

`npm run mutation` covers `src/core` and `src/pluggy` and now has to cover `src/storage` too, since the derivation moved there.

## Acceptance

The PRD's three:

- "quanto gastei com mercado?" returns a figure, and filtering by that category agrees with the group total in the unfiltered call.
- Correcting one transaction sticks across a re-sync.
- Correcting a merchant by CNPJ applies backwards over everything they already sold you.

And one this design adds, which is the only one that actually proves the phase did its job — and which does not require waiting fifteen days to run:

**Replay the same fixture twice, the second time with every `category` nulled, as though the tier had already changed. Every aggregate, every group total and every filtered query must return the same numbers.** What may legitimately change is `categorySrc`, from `pluggy` to `pluggy` for harvested rows and to `learned` or `mcc` for the rest.

## What this phase gives up

**The `description_norm` → category map.** It is the only signal that reaches the 259 rows (14.8%) carrying neither an MCC nor a document, and it is the only cut here with an expiry date: after the window there is nothing left to learn it from. Cut deliberately, on YAGNI, with the irreversibility on the record.

**The V2 rule engine**, unchanged from §12.9.

**Learning from CPF** — see D4. Manual correction still covers it.

**Granularity finer than the 22.** The leaf is stored in both `transactions` and the snapshot, so this is deferred rather than foreclosed.

**Unsetting a category.** Overwrite is the undo.

## Open

1. Is 14.8% tolerable — PRD open decision 7. This design does not answer it; it preserves the ability to answer it, because the snapshot keeps the labelled history that any future measurement would need.
2. Whether `GET /categories` is actually gated with enrichment. D3 makes the question moot rather than answering it.
3. Whether `doctor` should report harvest coverage and weak mappings. Natural, and out of scope here.

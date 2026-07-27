# Phase 2 — Transactions: design

Written 2026-07-26, after Phase 1 shipped and after the Phase 0.5 recon invalidated `GET /transactions`. Revised the same day after a staff review; the findings that changed the design are recorded inline rather than as a changelog.

Phase 2 is the core of the product: `getTransactions`, `listTransactions` and `getTransactionDetails`, plus description normalization and the transactions cache. `docs/prd.md` sets the acceptance bar; `docs/adr/0001-stack-and-architecture.md` §14.2 and §12.5 set the engineering constraints, and its 2026-07-26 amendments are what this design is written against rather than the original prose.

The PRD's acceptance for this phase: *"quanto gastei em junho?" returns a total computed over every page of every account, and asking for detail is a separate, bounded step that cannot flood the context.*

## Decisions this design closes

| Decision | Resolution |
|---|---|
| PRD #1 Cache freshness by range | The cache is not range-scoped. See "Cache architecture" |
| PRD #4 What `getTransactions` groups by | Category, single dimension, no `groupBy` parameter |
| PRD #6 Test fixtures without real statements | Hand-authored synthetic fixtures, no scrubbed captures |
| ADR §12.12 #3 Does `descriptionRaw` feed normalization | No. Normalization reads Pluggy's `description` |
| Sign convention | Normalized at read time, money out is negative on every account type |

## Cache architecture

### Why the cache is not range-scoped

The obvious design is "cache the ranges you fetched, and fetch the gaps". It does not apply here, because **`GET /v2/transactions` cannot be asked for a range at all**. Per ADR §14.2's amendment, `from`, `to`, `page`, `pageSize`, `limit`, `perPage`, `first` and `itemId` are each rejected with a 400 naming the offending parameter. `accountId` is required; `after` is the only other accepted parameter, and it carries a cursor.

So a fetch is never partial by range. Following the cursor to `next === null` yields that account's entire available history, and there is no request that yields less. Range-scoped bookkeeping would be tracking a distinction the API cannot express.

**What that means concretely.** The user asks for Santander's last 7 days. No cache row exists, so we walk the whole cursor chain and store every transaction it returns, however far back that goes. We then filter to 7 days in SQL to answer. The user then asks for 30 days: the history is already complete, so the read is served without re-walking. The first fetch was never scoped to 7 days — only the read after it was.

`startDate` / `endDate` are therefore **always** applied locally, against the cache, and never sent to Pluggy.

### Why a full re-walk rather than an incremental one

Not because the cursor is opaque. The recon decoded it: `after` base64-decodes to `<ISO-8601 timestamp>|<uuid>`, a keyset over `(date, id)`, and rows come back date-descending on all six accounts. Walking from the top and stopping at the first already-cached page is technically available.

We do not do it, because an early stop assumes **ids are stable across syncs and already-fetched pages are immutable**, and neither is known. PRD Phase 0.5 still lists "whether a transaction id survives a re-sync" as open, and 74 rows in the recon are `PENDING` — a state whose amount typically changes on settlement. A full re-walk plus the convergent write below is correct whether or not those assumptions hold. Revisit if the id-stability question is ever closed affirmatively.

### Freshness: `lastUpdatedAt`, not a TTL

A calendar TTL is the wrong instrument here, and the ADR already has one scar from trying: §15's original "7-day freshness rule" was written on the premise that connectors update within a 7-day Open Finance window, and Phase 1's amendment deleted it once connector 200 reported `isOpenFinance: false`.

Instead, freshness is keyed off a signal we already fetch. `transaction_sync` stores, per account, the connection's `lastUpdatedAt` observed at the moment that account's history was last fully walked.

- Row exists and its stored value equals the connection's current value → the bank has not synced since we walked; serve from cache without re-walking.
- Values differ, or no row exists → re-walk the account's full cursor chain.
- **The connection reports `lastUpdatedAt: null` → always re-walk, and log a warning.** `Connection.lastUpdatedAt` is `Date | null` and `ITEM.lastUpdatedAt` is `z.string().nullable()`, so this branch is reachable even though all three connections in the recon reported a timestamp. Null means freshness is unknown, and an unknown must not be read as unchanged. The cost is a redundant walk on a connector that never populates the field; the alternative is a cache frozen forever with no signal.

**A warm read still costs one `GET /items/{id}` per connection.** The current `lastUpdatedAt` is only obtainable from the item, so "served from cache" means "the history is not re-walked", never "no network call". Stating it plainly, because an implementer who reads it as zero-network will invent a local TTL over `lastUpdatedAt` — which is the calendar TTL this section rejects.

**No backstop max-age, deliberately.** Phase 0.5 found one of three connections stalled for three days with `status: UPDATED`, no error, and `nextAutoSyncAt: null`. Under this design our cache for that connection also sits still — consistent with what the bank itself reports, and visible through `dataThrough` below. A backstop would mean inventing a number the recon has already shown a connector can violate, and re-walking full history to discover nothing changed.

### The cursor walk

Per ADR §14.2's amendment, the old invariant ("terminate on the reported total, assert it") has nothing left to assert against. What replaces it:

- **Terminate on `next === null`, and on nothing else.** A short page carries no information: 500 rows on a full page, 53 on a tail, and 3 on a three-row account are the same shape.
- **Join `next` as a query string, not a URL.** It begins with `?`, carries no host and no path. The correct join is `${BASE}/v2/transactions${next}`. Getting this wrong is what produced 500 rows from an account holding 1053, silently, during the recon that discovered the endpoint.
- **Assert the cursor advances.** Two consecutive responses carrying the same `after`, or a page returning ids already seen in this walk, is an error.
- **Cap the hop count at 500 and fail loudly on the cap.** At the observed 500-row page ceiling that is 250,000 rows, past any plausible personal wallet, so reaching it signals a bug rather than a large account.

### The write is convergent, atomic, and single-flighted

Three properties, each closing a failure the walk would otherwise have.

**Convergent.** A full walk is the authoritative set for that account, so any cached row for it that the walk did not return is stale — a reversed transaction, a withdrawn row, a `PENDING` row that settled under a different id. Upsert alone never removes those, and aggregates drift permanently upward with nothing erroring. The write is therefore upsert-all **plus** `DELETE FROM transactions WHERE account_id = ? AND id NOT IN (walked ids)`. This is what makes the design correct whether or not ids survive a re-sync.

**Atomic, without holding a transaction across `await`.** `node:sqlite`'s `DatabaseSync` is synchronous and connection-scoped; a `BEGIN` left open across a page fetch would swallow a second walk's `BEGIN` with `SQLITE_ERROR: cannot start a transaction within a transaction`. So the walk buffers every page in memory and the store performs upserts, the delete and the `transaction_sync` stamp in **one synchronous call** after the last page. `TransactionStore.replaceAccount` is that call, and its single-statement shape is the reason it exists.

**Single-flighted per account.** An MCP client can have several tool calls in flight — Phase 1 builds for it, and `transport.ts` already single-flights `POST /auth` for the same reason. Without it, two concurrent questions both see a stale `lastUpdatedAt` and both walk all six accounts, doubling the request count on the most expensive operation in the project, against a rate limit whose window PRD Phase 0.5 still lists as unanswered. Concurrent callers for the same `accountId` await the same walk promise.

## The transaction model

`src/core/transaction.ts`:

```
id, accountId, connectionId,
accountType, accountSubtype,   // denormalized, see "why" below
occurredAt,                    // the full instant, as reported
localDate,                     // YYYY-MM-DD in America/Sao_Paulo
amountCents,                   // normalized, in the ACCOUNT's currency
currency,                      // the ACCOUNT's currency
originalAmountCents, originalCurrency,  // null unless the purchase was foreign
description, descriptionNorm,
categoryId,                    // the leaf id Pluggy reported, or null
document,                      // counterparty CPF/CNPJ, digits only, or null
counterpartyName, paymentMethod,
mcc, billId,                   // or null
instalmentNumber, instalmentTotal, purchaseDate
```

**The detail fields are columns, not stored blobs.** An earlier draft kept `paymentData` and `creditCardMetadata` as raw JSON "for forward compatibility" and had `getTransactionDetails` project from them. That was hand-waving in two directions: nothing in the write path ever populated them, and reaching them from SQL would need `json_extract` over every row — which is what ADR §12.3 rules out for the Phase 3 `COALESCE` chain. Extracting the six fields we actually name costs six columns and removes both problems.

Money is integer cents throughout.

### Currency: the row's currency is the account's

**This is the correction that matters most.** `amountCents` is `amountInAccountCurrency ?? amount`, which is by definition denominated in the account's currency. Storing `transaction.currencyCode` next to it would be storing a *different* unit's label: the recon found 32 `USD` and 1 `CLP` rows on cards whose accounts all declare `BRL`, and `amountInAccountCurrency` is non-null on exactly those 33 rows.

Left uncorrected, the mixed-currency refusal below would fire on any wallet containing an international card purchase — this wallet — and every aggregate would refuse, while the acceptance scenario asserting that a USD 20 purchase contributes R$100 would fail. So:

- `currency` is the **account's** currency, and the mixed-currency guard compares account currencies, exactly as `core/balance.ts` already does. An international purchase never trips it.
- `originalAmountCents` / `originalCurrency` carry the pre-conversion figure, `NULL` on domestic rows. They exist for presentation only and never enter a total. ADR §12.12 leaves "report the original alongside the converted" open; storing it costs nothing and keeps the answer available.

### Sign normalization

Per ADR §14.1's amendment, the sign convention **inverts** between account types: on a `BANK` account a debit is negative, on a `CREDIT` account a debit is positive. A mixed `SUM(amount)` does not merely mean nothing — it partially cancels and lands on a believable figure.

**Normalization adopts `BANK`'s convention: money out is negative.** It is what ADR §14.2's own aggregate example assumes (`{"label": "Mercado", "total": -4200.00}`), and it makes a cross-account sum correct rather than cancelled.

The flip needs the account type, which `GET /v2/transactions?accountId=` does not return. So the contract takes the account, not its id — mirroring `toAccount(account, connection)`, which already establishes that the mapper receives the context it needs:

```
Bank.getTransactions(account: Account): Promise<readonly Transaction[]>
toTransaction(wire, account)
```

`CREDIT` negates, `BANK` passes through, and **any other account type is a response-shape error**. That closes the hole where an `INVESTMENT` account id reaches `/v2/transactions` and gets normalized under a convention nobody measured.

### Cents: reuse `toCents`, do not re-invent a check

An earlier draft of this design mandated `|value * 100 − round(value * 100)| < 1e-6` and refusal on failure. **That was wrong twice**, and is recorded here because it is the kind of wrong that looks like rigour:

- It computes in binary floating point, which is precisely what `parseDecimalDigits` / `roundDecimalCents` in `pluggy/mapper.ts` went to BigInt lengths to avoid.
- It would refuse data Phase 1 serves today. The open-bill probe found Nubank sending four decimals (`307.8891`, `56.8248`) and its recommendation is *"`toCents` already rounds half-away-from-zero over the decimal representation without touching binary floats. Reuse it."*

So Phase 2 reuses `toCents`. Sub-cent input is a `warn` log line naming the account, not a refusal — the rounding is provably correct, and the recon measured zero sub-cent noise across 1751 transaction amounts.

### Dates: local calendar days, not UTC

`occurredAt` stores the instant as reported. `localDate` stores the calendar day in **`America/Sao_Paulo`**, computed at insert with `Intl.DateTimeFormat` (`en-CA` yields `YYYY-MM-DD`; no dependency).

**Both sides of every date comparison go through the same function**, which lives in `core/date.ts` because `core/aggregate.ts` needs it as much as the mapper does. The "today" that splits `spent` from `upcoming`, and the one that bounds `dataThrough`, are derived from the injected `Clock` through that function — never from `toISOString().slice(0, 10)`. At 22:00 in São Paulo the UTC date is already tomorrow, so the naive form moves an evening's purchases into `upcoming` and reports nothing spent today. Truncating one side correctly and the other carelessly reintroduces exactly the bug `localDate` exists to prevent.

An earlier draft said "compared in UTC" and cited the open-bill probe. That citation was about `dueDate`, a different field with a different shape. For transaction dates the recon says the opposite: most rows are `T03:00:00.000Z`, which *is* Brazilian midnight rendered in UTC, but *"some carry a real timestamp"*, and *"UTC is the wrong one for a Brazilian midnight"*. A purchase at 22:00 BRT on 30 June is `2026-07-01T01:00Z`; truncated in UTC it lands in July and drops out of "quanto gastei em junho".

Baking the timezone into `localDate` at insert makes range queries indexable. Changing the timezone later is a `cache.db` rebuild, which the `PRAGMA user_version` policy already provides.

### Why `accountType`, `document` and `mcc` are columns

`accountType` / `accountSubtype` are denormalized onto the row because `getTransactions` declares `accountType` and `accountSubtype` filters, and a filter with nothing to filter against is exactly PRD bar #3's scar — *"a declared filter that was parsed, validated and then never read"*. The account is already in hand for the sign flip, so the copy is free.

`document` (digits only, `NULL` when absent, per ADR §12.2) and `mcc` are extracted now rather than left inside the `paymentData` / `creditCardMetadata` blobs. Phase 3's `COALESCE` chain joins on both, and reaching them through `json_extract` over every row would make that query a rewrite instead of an addition. We are already parsing the payload.

## Description normalization

A pure function in `src/core/description.ts`, applied at insert so `description_norm` is written once.

```
"PAG*DEIVYN LANCHES LTDA 03/12"
  → uppercase → strip accents → strip acquirer prefixes
  → strip trailing date/sequence → collapse whitespace
  = "DEIVYN LANCHES"
```

It ships in Phase 2 even though nothing reads it until Phase 3, because ADR §12.5 is explicit that retrofitting it later means rewriting every cached row.

**Normalization reads Pluggy's `description`, not its `descriptionRaw`** — closing ADR §12.12 point 3. `description` is populated on 100% of rows, `descriptionRaw` on 96.7%, and deriving a `NOT NULL` normalized column from a nullable source is a bug waiting at insert time. Our field is named `description` to match, and the earlier draft's `descriptionRaw` name is dropped: it collided with a real Pluggy field holding something else.

Two further points:

- **The acquirer prefix list is data, not logic.** A `const` array (`PAG*`, `PG *`, `CIELO*`, `REDE*`, …) the function iterates. ADR §12.5 says outright to expect it to grow with experience, so it must be trivially appendable with a test case per addition — not buried in a regex alternation.
- **Growing the list bumps `cache.db`'s `user_version`.** Adding a prefix is a code change, so nothing would otherwise rebuild the cache and every existing row would keep its stale `description_norm` forever. Folding the normalizer's version into `user_version` makes the existing drop-and-rebuild policy do the work, in one line.

Normalization applies to `BANK` rows too, where the description is typically a PIX counterparty name. Stripping acquirer prefixes there is a no-op, but the trailing-sequence stripper could eat something meaningful off a transfer description, and that needs a pinning test.

## Category roll-up

`src/core/category.ts` already fixes the 22 top-level ids. The transitive `parentId` tree is Phase 3 seed work per the PRD — but Phase 2 needs it, because grouping a transaction categorized as *Life insurance* anywhere other than *Insurance* is a wrong number, and the recon found parents and children both used as categories in their own right (Transfers carries 143 rows directly against 111 across its ten children).

**Phase 2 pulls the roll-up forward, read-only.** `GET /categories` is fetched and the transitive parent map built from it.

**Store the leaf, derive the group.** `category_id` holds the id Pluggy reported, untouched. The roll-up happens at read time, per the project's derive-don't-store rule — and, as the next section shows, the exclusion rules for `spent` need the leaf, which a stored roll-up would have destroyed.

Three constraints from ADR §12.4's amendment:

- **The roll-up is transitive.** The tree is three levels deep in places. Code that walks one level up loses the leaves.
- **Never slice the id.** 126 ids are 8 characters; the four Insurance children are 9. Positional derivation works on 126 of 130 entries and produces `20010000`, which is not a category.
- **Trust `parentId`, not `parentDescription`.** Three entries under *Loans and financing* disagree, and sit misfiled at the source.

**Where the pieces live.** `core/taxonomy.ts` is pure — `buildRollup(entries): ReadonlyMap<string, CategoryId>`, no memo, no module state. Caching the fetched response belongs with the other remote-response cache, in `pluggy/client.ts` behind `Bank.getCategories()`, next to the API key cache in `transport.ts`. Phase 1's design rejected process-global state inside a business rule by name, and a module-level memo in `core/` is that shape: untestable, order-dependent under `node --test`'s single process, and with undefined behaviour on a failed fetch.

**Labels come from `core/category.ts`, not from the fetched strings.** The recon found `descriptionTranslated` for `05040000` reading `Transferências- DOC` with a missing space, and warns the Portuguese strings are not safe as display text. The fetch supplies structure; the labels are already ours.

## The tools

Money crosses the MCP boundary as a decimal string via the existing `mcp/format.ts` `toDecimal`, matching Phase 1.

### `getTransactions({ startDate, endDate, categories?, minAmountCents?, maxAmountCents?, accountType?, accountSubtype? })`

Groups by rolled-up category — a single dimension, no `groupBy` parameter.

```jsonc
{
  "from": "2026-06-01", "to": "2026-06-30", "currency": "BRL",
  "spent": "4820.15", "received": "7200.00",
  "groups": [
    { "category": "10000000", "label": "Supermercado", "total": "-1240.00",
      "count": 37, "sampleIds": ["...", "..."] }
  ],
  "upcoming": { "total": "-890.00", "count": 5 },
  "accountsCovered": 6,
  "dataThrough": [{ "connectionId": "...", "through": "2026-07-08" }]
}
```

**`spent` and `received` exclude transfers between your own accounts.** This is the second correction that changes a number. With the sign flip, a credit card bill payment appears twice: negative on the checking account, and — because it is a `CREDIT`-type row that Pluggy signs negatively — flipped to positive on the card. So "quanto gastei em junho?" would report the month's purchases *plus* the payment that settles them, and separately report that payment as income. The recon has 44 rows under `05100000 Credit card payment` and 71 under `04000000 Same person transfer`.

The exclusion runs on the **leaf** id, not the rolled-up group: `05100000` rolls up into `05000000 Transfers`, and excluding the whole group would also drop genuine outgoing payments to other people. Excluded leaves: `04000000` with its children, and `05100000`. They still appear in `groups[]` — only the headline figures skip them.

**`spent` and `received` are positive magnitudes.** Their names carry the direction; `spent: -4820.15` renders as "you spent minus R$4,820". Group totals stay signed, so a category with refunds nets correctly.

**Future-dated rows are separated into `upcoming`.** The recon flags instalment rows dated up to four months ahead. Counted in `spent` they report money as already gone; dropped silently they vanish. Rows with `localDate` after today are excluded from `spent` / `received` and reported as their own figure.

**`sampleIds` capped at 10**, per ADR §14.2, taken as the 10 largest by absolute amount — the ones a person would ask about. Without ids no V1 tool emits one, and `getTransactionDetails` and Phase 3's `setCategory` become unreachable, the circularity the ADR already caught once.

**`dataThrough` replaces an `asOf` built on `lastUpdatedAt`.** The open-bill probe's fourth question is exactly this: the gold card's statement trails its utilization by 18 days, and it observed a transaction feed stopping on 08/07 under a connection reporting an update on 26/07. A connection's update time therefore says nothing about where its transactions stop, and reporting it would hand back a stale number wearing a current one's face. `dataThrough` is `MAX(local_date)` over cached non-future rows — one query, and the only honest freshness signal this tool has.

**`minAmountCents` / `maxAmountCents` are integers, in cents, bounding the normalized signed amount.** The unit is in the name because a bare `minAmount` invites a float. `maxAmountCents: -10000` finds spends of at least R$100, and sign alone separates income from spending.

### `listTransactions({ ...same filters, limit, cursor })`

Hard cap `limit <= 100`, per ADR §14.2. Returns rows with `id`, `date`, `descriptionNorm`, `amount`, `category`.

**The cursor is ours** — a keyset over `(localDate DESC, id DESC)`, matching Pluggy's own ordering. Pluggy's cursor cannot express our filters and does not survive across processes.

**The cursor carries a fingerprint of the filters, and a mismatch is refused.** A page 2 arriving with a different `startDate` or `categories` makes the keyset meaningless and the result silently wrong.

`listTransactions` triggers the same freshness check and walk as `getTransactions`; it would otherwise serve a cold cache. A re-walk landing between page 1 and page 2 can shift rows — the cursor is a keyset, so the page boundary stays coherent, but rows may appear or vanish. Documented in the tool description rather than defended against.

**A request above the cap is refused, not clamped.** Silently returning 100 rows to a caller who asked for 500 hands back a page they believe is complete.

**Deviation from ADR §14.2, recorded:** the ADR's row shape includes `category_src`. Phase 2 has exactly one source, so the field would be a constant. Phase 3 adds it back with the `COALESCE` chain.

### `getTransactionDetails({ ids })`

Full detail for ids the agent already chose. Cap of **20 ids** — a judgement call, chosen because these rows are fat; the ADR says "explicit, bounded set" without a number.

**It returns our shape, not Pluggy's.** An earlier draft said "including `paymentData` and `creditCardMetadata`", which would have re-exposed Pluggy's field names and its `itemId`/`billId` vocabulary through the boundary ADR §14.0 draws, and round-tripped its floats past `toDecimal` and past the never-money-through-a-`number` rule. The domain shape names its own fields: counterparty document, type and name, payment method, instalment number and total, purchase date, MCC, bill id. The raw blobs stay in the row for forward compatibility; they are not what crosses the boundary.

## Error handling

Following Phase 1's precedent: aggregates refuse a partial total, listings degrade with a named notice, transport stays a protocol error.

| Failure | Response |
|---|---|
| Connection unavailable, `getTransactions` | `isError` content naming it. **No total**, even if that connection's rows are warm in the cache — a total over a cache we cannot confirm is current is a partial total wearing a full one's face |
| Connection unavailable, `listTransactions` | Rows from available accounts, plus an explicit notice of what is missing |
| Unknown id, `getTransactionDetails` | `isError` content listing which ids were not found |
| Cursor stops advancing, or hop cap reached | `isError` content naming the account |
| `/v2/transactions` reached with a non-`BANK`/`CREDIT` account | Response-shape error |
| Mixed **account** currencies in one aggregate | `isError` content listing them, same as `getBalance` |
| `GET /categories` unreachable | `isError` content, for both `getTransactions` and `listTransactions` — both return categories, and grouping without the roll-up under-counts parents |
| Cursor filter fingerprint mismatch | `isError` content asking for the filters to be re-sent |
| `limit` above 100, or more than 20 ids | `isError` content naming the cap |
| Sub-cent amount | `warn` log, value rounded by `toCents`. Not a refusal |
| Database fails to open | `Source.ok: false`, same channel as missing credentials |
| Transport failure | Protocol error, unchanged |

The pair that matters most is "empty because nothing happened" versus "empty because a consent was revoked". They look identical and mean opposite things, and conflating them is PRD bar #1's fourth bullet.

**Input validation uses `safeParse`, not `parse` — a deviation from Phase 1.** `handleGetBalanceByAccount` calls `.parse` at the top of the handler, so a bad argument throws a `ZodError` and becomes a protocol error. That is defensible for a single account id. It is not defensible for the caps in this phase: the table above commits to `isError` content naming the cap, and an over-cap `limit` or an invented category is exactly the kind of thing ADR §14.0 says the model must be able to recover from. A thrown `ZodError` lands in the channel the model cannot see.

## Storage

`cache.db`, droppable and rebuilt from Pluggy, at a new `PRAGMA user_version`. `CACHE_MIGRATIONS` is currently empty, so adding a `to: 1` entry works as-is: `migrate()` sees the mismatch, `dropEverything` runs, the chain applies from 0.

```sql
CREATE TABLE transactions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  account_type TEXT NOT NULL,
  account_subtype TEXT,
  occurred_at TEXT NOT NULL,
  local_date TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  original_amount_cents INTEGER,
  original_currency TEXT,
  description TEXT NOT NULL,
  description_norm TEXT NOT NULL,
  category_id TEXT,
  document TEXT,
  counterparty_name TEXT,
  payment_method TEXT,
  mcc TEXT,
  bill_id TEXT,
  instalment_number INTEGER,
  instalment_total INTEGER,
  purchase_date TEXT
);
CREATE INDEX transactions_by_date ON transactions(local_date DESC, id DESC);
CREATE INDEX transactions_by_account ON transactions(account_id, local_date DESC);

CREATE TABLE transaction_sync (
  account_id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  last_updated_at TEXT
);
```

Absence is `NULL`, never `''`. Row presence in `transaction_sync` means "walked at least once", which is what distinguishes a never-walked account from one whose connection reports a null `lastUpdatedAt`.

`transactions_by_date` serves the primary access pattern — a date range across all accounts — and doubles as the keyset index for `listTransactions`. `transactions_by_account` serves the per-account convergent delete.

The 130-entry category tree is **not** seeded here; that is Phase 3's table.

## Composition and file layout

```
src/core/transaction.ts       domain type
src/core/date.ts              São Paulo calendar days, both sides of every comparison
src/core/description.ts       normalization (pure)
src/core/taxonomy.ts          transitive parentId roll-up (pure, no memo)
src/core/aggregate.ts         filter + group (pure)
src/core/transactions.ts      orchestration + per-account single-flight
src/pluggy/client.ts          + cursor walk, + getCategories with its cache
src/pluggy/wire.ts            + transaction and category schemas
src/pluggy/mapper.ts          + toTransaction
src/storage/transactions.ts   the typed relational cache
src/mcp/cursor.ts             keyset encode/decode with a filter fingerprint
src/mcp/tools/result.ts       textResult and finishToolError, shared
src/mcp/tools/transactions.ts getTransactions and listTransactions
src/mcp/tools/transaction-details.ts
```

The tools are split across two files and the boilerplate is extracted because `max-lines` warns at 250: three descriptions, three schemas, three handlers, the cursor and the detail projection do not fit in one. `textResult` and `finishToolError` are currently copied into both `tools/accounts.ts` and `tools/balance.ts`; a third copy would settle the duplication as the house style, so they move to `tools/result.ts` instead.

`core/contracts.ts` grows `Bank.getTransactions(account)`, `Bank.getCategories()` and `TransactionStore`:

```
TransactionStore = {
  syncedLastUpdatedAt(accountId): string | null | undefined  // undefined = never walked
  replaceAccount(accountId, connectionId, rows, lastUpdatedAt): void  // one sync transaction
  query(filter): readonly Transaction[]        // filter carries limit and the keyset `after`
  byIds(ids): readonly Transaction[]
  dataThrough(accountIds, today): ReadonlyMap<string, string>
}
```

`query`'s filter carries `limit` and an optional `after: { localDate, id }`, so `listTransactions` pages with a real keyset against `transactions_by_date` rather than loading every matching row and slicing in memory. Without them on the contract, the index below is decorative.

`replaceAccount` doing upserts, the convergent delete and the sync stamp in one synchronous call is what guarantees no `BEGIN` spans an `await`.

**Wiring, which Phase 1 does not currently have.** Phase 1 states flatly that `serve` opens no SQLite file, and `.dependency-cruiser.js`'s `only-bin-builds-infrastructure` forbids `src/mcp/` from importing `src/storage/`. So the database is opened in `bin/cata-centavo.ts`, and what reaches the tools through `Source` is the **reader**, not the store — `core/transactions.ts` exports `createTransactionReader({ bank, store, clock, log })`, holding the in-flight walk map in its closure, constructed once in `bin/`. It imports `TransactionStore` from `core/contracts.ts` and nothing from `storage/`, so the existing dependency rules cover it with no new rule. `Source.ok: false` grows a case for a database that fails to open, including `SchemaTooNewError`, which is a different failure class from missing credentials and must read as such. Database close happens on shutdown alongside the existing teardown.

**That wiring is verified by hand, not by a unit test.** `Source` is built by a private `toSource()` inside `bin/cata-centavo.ts`, which is a top-level-await script that reads `process.argv` and dispatches at module scope — importing it from a test runs the CLI. Phase 1 hit the same wall and answered it the same way, with a `printf | node` handshake rather than a unit test. `tests/fakes/fake-source.ts` grows the reader so the tool tests keep working; the composition root itself is checked in Task 15's live run.

**Freshness is read off the account, not fetched again.** `toAccount` already stamps the connection's `lastUpdatedAt` onto every `Account`, and `client.getAccounts` already fetches the item to obtain it. A separate `getConnection` per connection inside the reader would be a second request for a value already in hand — three wasted round trips per warm tool call on this wallet, against the rate limit whose window is still open question #4.

**Nested Zod fields use `.optional()`, top-level uses `.nullable()`.** Per ADR §14.3's amendment, top-level transaction fields are always present and explicitly `null` (23 keys on all 1751 rows), while fields nested inside `creditCardMetadata` are omitted entirely when absent, with zero explicit nulls. The two are not interchangeable, and this is where `exactOptionalPropertyTypes` earns its place.

## Observability

Phase 2 adds the most expensive operation in the project, so it gets the same treatment Phase 1 gives its tools: a child logger per call (`tool`, `callId`), `durationMs` and `outcome` on completion.

Per walk, one line carrying `accountId`, `connectionId`, `pages`, `rows`, `deleted`, `durationMs`, and whether it was triggered by a changed `lastUpdatedAt` or a null one. `deleted` is the interesting number: a nonzero count means ids moved under us, which is the evidence that closes the open id-stability question.

Everything to stderr. Nothing but JSON-RPC reaches stdout.

## Acceptance criteria

```gherkin
Scenario: The total covers history longer than one response carries
  Given an account whose transactions span several cursor pages
  When the user asks how much they spent in June
  Then the total counts every June transaction across all pages

Scenario: A cursor that stops advancing fails loudly
  Given the bank returns the same cursor on two consecutive responses
  When the user asks how much they spent in June
  Then the tool reports a failure naming the account
  And no total is returned

Scenario: Spending on a checking account and a card sums in one direction
  Given a checking account records a R$100 purchase
  And a credit card records a R$100 purchase
  When the user asks how much they spent
  Then the total reads R$200 spent

Scenario: Paying the card bill is not counted as spending
  Given a credit card records a R$100 purchase
  And the checking account records a R$100 payment of that card's bill
  When the user asks how much they spent
  Then the total reads R$100 spent
  And no income is reported

Scenario: A foreign purchase counts at its converted value without blocking the total
  Given every account is denominated in reais
  And a card records a USD 20 purchase the bank converted to R$100
  When the user asks how much they spent
  Then the purchase contributes R$100 to the total
  And the tool does not report a currency conflict

Scenario: A purchase late on the last evening of the month counts in that month
  Given a purchase made at 22:00 Brazilian time on 30 June
  When the user asks how much they spent in June
  Then the purchase is counted

Scenario: An instalment dated next month is not reported as already spent
  Given an instalment row dated three months in the future
  When the user asks how much they spent this month
  Then the instalment is absent from the amount spent
  And it is reported separately as upcoming

Scenario: A child category counts under its top-level parent
  Given a transaction categorized as "Life insurance"
  When the user asks for spending by category
  Then the amount appears under "Insurance"
  And no group named "Life insurance" is returned

Scenario: An unreachable connection blocks the total instead of shrinking it
  Given two connections, one with revoked consent
  When the user asks how much they spent in June
  Then the tool returns readable content naming the unavailable connection
  And no total is returned

Scenario: A genuinely empty period reads as empty
  Given every connection is available
  And no transactions fall in the requested period
  When the user asks how much they spent
  Then the tool returns no groups
  And reports zero spent

Scenario: A second question over the same account does not re-walk its history
  Given the user has already asked about the last 7 days
  And the connection reports the same update time as when it was walked
  When the user asks about the last 30 days
  Then the account's history is not fetched again
  And the answer covers the full 30 days

Scenario: A bank sync invalidates the cached history
  Given the user has already asked about June
  And the connection has since reported a newer update time
  When the user asks about June again
  Then the account's history is fetched again in full
  And the answer reflects the newer data

Scenario: A connection that reports no update time is always re-walked
  Given a connection whose last update time is unknown
  When the user asks how much they spent
  Then the account's history is fetched again

Scenario: A row the bank no longer reports leaves the cache
  Given an account whose history was cached with a transaction that has since been reversed
  When that account's history is walked again without it
  Then the transaction no longer appears in any total

Scenario: Two questions at once walk an account only once
  Given no history is cached for an account
  When two questions arrive before either completes
  Then the account's history is walked once
  And both answers are the same

Scenario: A request for more rows than the cap is refused, not truncated
  Given the user asks for 500 rows
  When the request is made
  Then the tool reports that the limit is 100
  And no rows are returned

Scenario: Paging with changed filters is refused rather than silently wrong
  Given the user has taken the first page of June's transactions
  When the user asks for the next page with a different date range
  Then the tool reports that the filters changed
  And no rows are returned
```

## Testing

TDD throughout, red first.

- **`core/description.test.ts`** — ADR §12.5 calls this the highest-value unit test in the project. A table test seeded from the ADR's own example and the recon's real shapes (the `03/12` trailing-instalment suffix), one row per prefix, plus the PIX-description pinning case.
- **`core/taxonomy.test.ts`** — three-level roll-up, the four 9-digit Insurance children, the three *Loans and financing* entries whose `parentDescription` disagrees with `parentId`, and a negative test that no code slices an id positionally.
- **`core/aggregate.test.ts`** — filtering, grouping, the transfer exclusions on leaf ids, the future-dated split, `spent`/`received` as magnitudes.
- **`pluggy/mapper.test.ts`** — extend the existing file. Sign flip per account type, `amountInAccountCurrency ?? amount`, the account-currency rule, `localDate` in `America/Sao_Paulo` including the late-evening case, `toCents` reuse.
- **`pluggy/client.test.ts`** — extend the existing file. The cursor walk against a fake fetch: multi-page, `next === null` termination, the relative-`next` join, a stuck cursor, repeated ids, the hop cap.
- **`storage/transactions.test.ts`** — `:memory:`. Convergent replace (the delete-not-in-walk), idempotence, the freshness comparison including the never-walked and null cases.
- **`mcp/tools/transactions.test.ts`** — one case per declared parameter, proving it reaches the query. This is the prior Go implementation's scar and the reason the rule exists. Table-driven over the parameter list.
- **Concurrency** — two simultaneous calls against a fake bank that counts requests.

**`npm run mutation`** over `core` and `pluggy` afterward. `stryker.config.json` currently covers `core`, `pluggy` and `mcp/format.ts`; **add `storage/transactions.ts`**, because the freshness comparison is exactly the green-but-assertionless case mutation testing exists to catch.

**Fixtures are hand-authored and synthetic**, closing PRD open decision #6. They exercise real shapes — the v2 `{results, next}` envelope, the `BANK`/`CREDIT` sign inversion, a foreign-currency row, `creditCardMetadata`'s omitted-versus-null keys — with entirely invented amounts, names and ids. Nothing is copied from a real capture, so there is no scrubbing step to get wrong in a public repository.

## Explicitly not in Phase 2

`setCategory`, `setCounterpartyCategory`, the MCC map, the `COALESCE` derivation chain, rules, bills and instalments.

**`status` is parsed and dropped.** The recon found 74 `PENDING` rows, whose amounts typically change on settlement, and Phase 2 counts them in totals with nothing marking them as provisional. That is a deliberate omission rather than an oversight: `PENDING` matters to the open bill, which is Phase 4's subject and has its own probe document. Recorded here so it is a decision rather than a gap.

Phase 2 reads **Pluggy's own enrichment category**, which the recon found populated on 99.7% of rows, rolled up to the 22 top-level groups. Phase 3 layers override → counterparty → MCC on top of it, and becomes the only source if enrichment ever goes away.

**Phase 2's grouping runs in memory, and that is temporary.** ADR §12.2 argues the category filter belongs in SQL, and §12.3 makes derivation-inside-one-query load-bearing. At 1751 rows the in-memory shape is not a performance problem, and building the seed table now would pull Phase 3's scope forward. What Phase 2 does instead is leave the door open: `document` and `mcc` are real columns, the leaf `category_id` is stored unrolled, and Phase 3 moves the derivation into SQL as an addition rather than a rewrite.

## Documents this design obliges us to amend

CLAUDE.md calls a change to one of these that does not reach the other a bug in the pair.

- **ADR §14.2** — `getTransactions` and `listTransactions` still describe `GET /transactions` in their prose; the amendment covers pagination but not the tool signatures. `minAmountCents` / `maxAmountCents` and the transfer exclusions are new.
- **ADR §14.7** — the tool inventory's effort estimates predate this design.
- **ADR §12.12** — point 3 (`descriptionRaw` feeding normalization) is closed here.
- **`docs/prd.md`** — open decisions #4 and #6 are closed; #1 was already moved here.

## Open questions

1. **Does a transaction id survive a re-sync?** PRD Phase 0.5 still lists it. The convergent write makes Phase 2 correct either way, and the `deleted` count in the walk log is the evidence that would close it. Closing it affirmatively would unlock incremental walks.
2. **The `getTransactionDetails` cap of 20** is a judgement call, not a derived number.
3. **The 500-hop cap** is likewise chosen rather than measured. It is a bug detector, not a capacity limit.
4. **Cold-start cost against the rate limit.** The first `getTransactions` over a cold cache walks every account's full history, and PRD Phase 0.5 still lists whether the general rate limit is per minute or per hour as unanswered. This is the first operation in the project large enough to find out.
5. **`amountInAccountCurrency` on a non-BRL account** is unmeasurable in this wallet.
6. **What happens to cached rows when a connection leaves configuration.** Out of scope here; they simply stop being read.

# [BE] listTransactions hides the instant and orders same-day rows by UUID

**Type:** Bug
**Priority:** Medium
**Tracker:** none (local markdown)
**Size:** 1 day

## Context

Every cached transaction carries the instant the bank reported, untruncated, and in a real cache 88% of them hold a real clock time rather than local midnight. `listTransactions` hides it twice over. The row it emits carries only `date`, the São Paulo calendar day, so the clock time never reaches the model; and the query sorts by `local_date DESC, id DESC`, where `id` is Pluggy's UUID, so rows sharing a day come back in an order that means nothing. Ask which of two rides came first last Saturday and the answer is a coin flip, even though the cache holds `15:01:33` and `19:38:01` for them. That same cache has 345 (account, day) pairs with two or more real-clock rows, so this is the common case rather than an edge.

The instant is not missing anywhere else: `getTransactionDetails` already returns `occurredAt`, but it caps at 20 ids and needs those ids up front, so it cannot answer a question about a day it has not already been pointed at.

## Where to look

`formatListRow` in `src/mcp/tools/list-transactions.ts` is the row shape, and adding the field there is additive and cheap. The ordering is not: `buildQuery` in `src/storage/transactions.ts` owns the sort, and `addKeysetFilter` right below it paginates by keyset over the tuple `(local_date, id)`, which has to grow in lockstep with whatever the sort becomes. `src/mcp/cursor.ts` encodes that position into the opaque cursor, so its payload changes shape too, and a cursor minted by an older build has to be refused rather than silently misread into skipped or repeated rows.

Exposing the field without fixing the sort is the worst of the three outcomes: the model would see two rows carrying `19:38:01` and `15:01:33` in that order and read it as chronology. One ticket, both halves, done together.

## What needs to happen

Emit `occurredAt` on every listed row, named and shaped exactly as `getTransactionDetails` already emits it, so the two tools agree. The tool description has to say what it is and when it is uninformative, since some rows sit at local midnight because the bank sent no time: future-dated instalments, and one connector that never reports a clock.

Sort by that same instant, keeping `id` as the tie-break so the order stays total and the cursor stays stable across pages. `findByIds` and `cardRows` sort on the same axis today and should follow, since a caller reading one card's history expects the list to agree with itself. Old cursors decode into a position that no longer matches the sort, so `decodeCursor` should refuse a payload missing the new component with the same readable message it already returns for a filter mismatch.

## Acceptance criteria

* A listed row carries the instant the bank reported, verbatim, neither truncated to the day nor shifted between timezones.
* Two rows sharing a local date come back ordered by that instant, newest first, not by id.
* Paging a range with a page size of 1 visits every row exactly once, including days where several rows share a local date and days where several rows share local midnight.
* A cursor minted before the change is refused with a readable message rather than skipping or repeating rows.

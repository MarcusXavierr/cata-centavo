# Phase 8 — Account-scoped transactions: design

Written 2026-07-27, after Phases 5 and 7 shipped and while Phase 4 is in flight on `feature/credit-card`. This phase is a follow-up: it ships no new tool, and changes two parameters and one response field across the three transaction tools Phase 2 delivered.

## The gap, and how it was found

Asked "what was my Santander bill last month", the assistant could not answer through the MCP at all and read `cache.db` with `sqlite3` instead. Two distinct reasons, and only one of them is this phase's.

**Phase 4 owns the first:** no tool reports a card's statement amount. `getBills` and `getBillSummary` are specified in ADR §14.3 and are being built right now, and they answer "what is the bill total" from Pluggy's own `totalAmount` rather than by summing rows.

**This phase owns the second, which is more basic:** *no transaction tool can be pointed at an account.* `getTransactions` and `listTransactions` accept `accountType` and `accountSubtype`, so the narrowest expressible question is "all credit cards" — three cards in the author's wallet. And the rows come back carrying no account identity, so a caller cannot partition the merged result afterwards either. "The Santander's transactions" is not a question this server can be asked or answered with today.

The workaround that exists is telling. `getTransactionDetails` *does* return `accountId` (`src/mcp/tools/transaction-details.ts:107`), capped at 20 ids per call. Identifying which of 155 rows in one billing cycle belong to one card takes eight round trips to learn something the database knew in the first `SELECT`.

## The ADR contradicts itself here, and that is why this was never built

§14.2 line 616 gives the signature:

```
getTransactions({ startDate, endDate, categories?, minAmount?, maxAmount?, accountType?, accountSubtype? })
```

Three lines later, line 619: *"Phase 2 uses `/v2/transactions` and applies `startDate`, `endDate`, category, **account** and signed cent filters from the cache."*

Either "account" is loose wording for the two type parameters, or it names a filter that never reached a signature. Phase 2 implemented the signature. Nothing in the phase's amendment (line 660) records the choice, because no choice was consciously made — the prose and the signature were read as agreeing.

**This phase resolves it in favour of the prose**, and owes §14.2 an amendment saying so.

## What the plumbing already provides

The cost is low because most of the work is done and pointed the wrong way.

| Layer | State |
|---|---|
| `core/contracts.ts:127` | `TransactionFilter.accountIds: readonly string[]` — already plural, already required |
| `storage/transactions.ts:127` | Already emits `t.account_id IN (…)`, already binds the ids as parameters |
| `storage/transactions.ts:111` | Already treats an empty `accountIds` as "match nothing" rather than "match all" |
| `mcp/tools/transaction-input.ts:43` | Fills `accountIds` with **every** configured account, unconditionally |
| `mcp/tools/list-transactions.ts:144` | Emits six fields per row; `accountId` is not one of them |

So there is no new SQL, no new index (`transactions_by_account` exists), no cache migration and no change to `core/`'s filtering. Two files carry the behaviour change.

## Decisions

### Plural `accountIds`, not singular `accountId`

`TransactionFilter.accountIds` is already a list and the SQL already builds an `IN`. A singular parameter would be a narrower surface wrapped over a wider one for no gain, and it cannot express "both of my Nubank accounts" — a real question on a wallet where one connection serves a checking account and a card. An agent that wants one account passes a one-element array.

This also keeps `getTransactions` and `listTransactions` symmetric with `getBills(accountId)` and `getBalanceByAccount(accountId)` being singular for the right reason: those address one account by identity, this one filters a set.

### An unknown id is `isError` content, never an empty result

The requested ids are intersected with the configured account set, and **an id in neither is a readable `isError` naming it**, consistent with `getBalanceByAccount` and with the Phase 4 error table.

Passing the ids straight through to the `IN` clause is the tempting shortcut and it is the exact shape of pitfall #7: an unknown id matches no rows, the tool reports zero transactions, and "you spent nothing at the Santander in June" is indistinguishable from the truth. ADR §14.5's Phase 5 amendment made this class of failure loud for consent; the same rule applies to a typo'd account id.

The intersection also has to survive `accountType` being passed alongside: `accountIds: [<a BANK account>], accountType: "CREDIT"` is legally empty, not an error. The two filters compose; only an id that names nothing at all is a mistake.

### `accountId` on every listed row, unconditionally

`formatListRow` gains a seventh field. The alternative — emit it only when the result spans more than one account — saves tokens on the pinned case and makes the response shape conditional, which is worse for the consumer than the tokens are expensive. The house already strips `null`/`undefined` on serialization, so optional fields exist (`cursor`, `notice`), but those are absent because there is nothing to say, not because the caller could have deduced them.

The cost, stated rather than waved at: a UUID plus its key is roughly 20 tokens, so a full 100-row page grows by about 2k tokens against a page that already carries a description, a category and a category source per row. Phase 2's design calls `listTransactions` "the tool that can blow a context window" and the `limit <= 100` cap is what protects it; this does not move that cap.

`getTransactionDetails` already returns `accountId` and needs no change.

### No `groupBy: account` on `getTransactions`

Phase 2's design closed PRD #4 with "category, single dimension, no `groupBy` parameter", and this phase does not reopen it. Filtering to one account and grouping by category answers "what did I spend on the Santander, by category" without a second grouping dimension. A per-account breakdown of one category is `listTransactions` with the same filter.

### The cursor binds itself

`encodeCursor(position, filter)` hashes the filter into the cursor payload, so adding `accountIds` to `TransactionFilter` makes a cursor issued under one account set fail against another with no extra code. This is worth an explicit test rather than an assumption, because it is the one place where the change is invisible and the failure would be silent paging across the wrong rows.

## Non-goals

- **Bills.** Phase 4 owns `getBills` and `getBillSummary`. This phase makes "which rows are the Santander's" answerable; it does not make "what does the Santander bill total" answerable, and the two should not be confused when reading the session that motivated both.
- **Institution or account name on the row.** `accountId` plus `getAccounts` is a join the agent can do once per conversation. Denormalizing a display name onto 100 rows costs more than it saves and creates a second place for the name to be stale.
- **A short alias for the account id.** An index or slug per account would be cheaper per row and introduces a second identity space that every other tool would then have to speak. Explicit over clever.

## Deliverables

1. `accountIds?: string[]` on `getTransactions` and `listTransactions`, validated at the boundary and intersected against the configured accounts.
2. An unknown id returns readable `isError` content naming the id.
3. `accountId` on every `listTransactions` row.
4. Updated tool descriptions in the three-part template — the description is the only discovery surface, and a filter nothing mentions is a filter nothing uses.
5. Tests proving each parameter reaches the SQL, per ADR §16's named failure: a declared filter that was parsed, validated and never read. This is the rule mutation testing exists to check, so `npm run mutation` runs after, and the survivors get read.
6. An amendment to ADR §14.2 recording that line 619's "account" is now true, and that it was not before.

# Phase 1 — accounts and balances

Design agreed 2026-07-26, hardened after review the same day. Delivers `getAccounts`, `getBalance` and `getBalanceByAccount`, plus the MCP server they are the first inhabitants of. `docs/prd.md` says what "done" means; `docs/adr/0001-stack-and-architecture.md` §14.1 and §15 describe the phase, and every amendment this document makes to them is marked.

## What ships

Three tools, the `src/mcp/` tree that hosts them, the `serve` branch of the CLI, and a `.mcp.json` that plugs the server into a local Claude Code session.

What does **not** ship, against ADR §15's description of this phase: the lazy cache path in `storage/`, and the 7-day freshness rule. Both amendments are argued below.

The `Clock` port, which ADR §15 also lists under Phase 1, already exists in `core/contracts.ts` and stays. The tools use it for `durationMs`; no freshness rule reads it, because there is no longer one to read.

## Decisions

### No cache

The PRD lists "cache freshness by range" as blocking Phase 1. It does not block this phase, because *range* is a property of transactions. An account balance is a snapshot. So Phase 1 talks to Pluggy directly, ships no migration, no `store.ts` and no freshness rule, and the open decision moves to Phase 2, where a date range first exists.

The migration runner stays where it is, both chains still empty. That was already its designed state.

### The 7-day freshness rule is withdrawn

ADR §15 asks Phase 1 for "the 7-day freshness rule — freshness only matters for the last 7 days, since regulated Open Finance connectors update within a 7-calendar-day window". The reconnaissance found our connector reports `isOpenFinance: false`, `PATCH /items/{id}` is refused outright, and one of three connections has been stalled for three days with no error, no `statusDetail` and no `nextAutoSyncAt`. We do not control freshness and cannot restore it.

What replaces the rule: every account carries the `lastUpdatedAt` of its connection. Reporting when the bank last spoke is the only honest freshness signal available, and it is one the model can act on.

**Freshness is reported and never gates.** A three-day-stale connection is still totalled into `cash`, with its date in `asOf`. There is no staleness threshold that turns a balance into a refusal, because there is no threshold we could defend — the connector gives us no way to distinguish "stale" from "stale and wrong". This is a deliberate limit on the argument in *Partial failure* below, which refuses to put a number next to a caveat: a *failed* connection means we know a figure is missing, a *stale* one means we know when it was last right. The second is a fact about the number, not a hole in it.

### Tool names are camelCase

`getAccounts`, `getBalance`, `getBalanceByAccount`. This closes open decision #2 of the PRD.

The ADR being written in camelCase is the weaker half of the argument; the deciding half is that parameters are camelCase either way, because they come out of Zod schemas and TypeScript field names. `get_balance_by_account({connectionId})` is the inconsistent middle, and the alternative — snake_case parameters — fights the language.

Cost accepted: snake_case is the dominant convention across the reference MCP servers, so the model sees that shape far more often.

### Partial failure is decided per tool

This closes open decision #3 for the failure classes Phase 1 can reach.

`getAccounts` returns what it has plus an explicit `unavailable` list naming each connection that failed and why. It is a listing, and a missing account is visible in it.

`getBalance` fails whole, as readable `isError` content naming the connection. It is an aggregate, and PRD rule #2 forbids reporting partial coverage as a total. No cash figure appears anywhere in a failed result — a number next to a caveat is a number that gets read without the caveat.

The distinction is aggregate versus listing, which is what the rule is about.

**A connection that answers with zero accounts counts as unavailable.** A revoked or expired consent does not produce an error: Pluggy answers `200` with an empty list. Under the naive reading `getAccounts` would report that connection as healthy and `getBalance` would *succeed*, totalling over a subset — which is PRD failure #1's fourth bullet ("reporting an empty result as 'you spent nothing' when the real cause is a revoked consent") arriving through the one door the partial-failure rule left open. So a configured connection returning no accounts becomes an `unavailable` entry with `kind: "no-accounts"`, and `getBalance` refuses for the same reason it refuses a thrown failure.

This is deliberately the cheap half. PRD Phase 5 owns consent state proper — `listSources` reporting *why* a connection is empty, via `/consents`. Phase 1 only refuses to call an empty connection healthy. The recon confirms the distinction is unmeasured rather than absent: all three consents carry `revokedAt: null`, so the revoked payload is still unobserved, and Phase 5 is where it gets characterized.

### Money leaves as a decimal string

Integer cents internally, converted inside `pluggy/mapper.ts` at the point a Pluggy account becomes ours.

The conversion is one named function, `toCents(value: number): number`, and its three properties are the specification: it rounds half away from zero, it is symmetric on negatives (`toCents(-1.005) === -toCents(1.005)`), and it never returns `-0`. `Math.round` alone satisfies none of the three — `Math.round(-0.5)` is `-0`, and it rounds half *up*, which is asymmetric across zero. The negative path is live, not hypothetical: whether a credit card `balance` arrives negative is exactly what step 0 exists to determine.

`JSON.parse` has already produced a double by then and that is unavoidable; the risk the rule guards against is accumulation, not parsing. The recon's evidence that whole cents are lossless was measured on transaction `amount` — 1751 rows, no sub-cent noise — and **not** on `account.balance`, `creditLimit` or `availableCreditLimit`. Step 0 measures those three, since it is already fetching them.

Tool output is a decimal string — `"balance": "1500.00"`, with `currency` alongside. Emitting integer cents to a model invites reading `123456` as `R$ 123.456`, and PRD failure #1 is the confidently wrong number that nobody audits.

Serialization strips `null` and `undefined` only, never falsy. A balance of exactly `0` disappearing is a financial bug.

### Mixed currencies are refused, not summed

Every `Account` carries its own `currency`. `getBalance` emits one `currency` field beside one `cash` figure, so the two shapes only agree while every account holds the same currency — which is true of this wallet (all six declare `BRL`) and is not a property of the API.

PRD failure #1's second bullet is "summing across currencies … silently adds dollars to reais", and the recon's rescue for it, `amountInAccountCurrency ?? amount`, is a **transaction** field. Nothing equivalent exists on an account balance. So the guard is structural rather than corrective: `core/balance.ts` groups by currency, and when more than one currency is present it returns a failure the tool renders as `isError` naming the currencies found. It never picks one and never converts.

Five lines today, and the difference between "we never hit it" and "we hit it silently".

## Step 0 — probe the endpoints before writing tool code

ADR §14.1 has `getAccounts` merging `/accounts`, `/investments` and `/loans`. The reconnaissance called none of the last two, and `/transactions` — the endpoint everyone assumed was fine — answered 410.

So a short read-only script against the three configured connections, in the shape of the Phase 0.5 capture, answers four things before any tool code is written:

1. Do `/investments` and `/loans` answer 200, 404 or 410, and what shape do they return?
2. What is the **sign** of `balance` on a credit card account?
3. Does `GET /accounts/{id}` work as a direct lookup, and does the returned body carry `itemId`? Both matter — see *One account's balance* below.
4. Do `balance`, `creditLimit` and `availableCreditLimit` carry sub-cent noise? The recon measured this on transaction `amount` only.

Question 2 can be **decided** rather than merely observed, and cheaply. The recon confirms `creditLimit` and `availableCreditLimit` are populated on all three cards, so `creditLimit − availableCreditLimit` is the used amount independently of `balance`'s sign. Step 0 compares the two, and the mapper keeps the comparison as an assertion: if they ever disagree, that is `owed` inverting, caught at the boundary instead of in a number the user reads.

Findings land in `docs/research/`, and the anonymized bodies become the fixtures for the mapper tests.

### Both branches of the investments question, written now

Leaving this to "step 0 will tell us" is what left the domain type and two acceptance scenarios contingent on a script nobody had run. Both branches are therefore specified here:

**If `/investments` answers 200,** positions map to `Account` with `type: "INVESTMENT"`, and ADR §16.1's two rules come with it. The liquidated filter, verbatim including all three conditions: skip when `status == "TOTAL_WITHDRAWAL" && balance == 0 && amount == 0` — Pluggy returns fully-withdrawn positions forever, and the three-way `AND` is itself the finding. And the nested `transactions[]` array a position carries is stripped, because it is unbounded and would dominate the response.

**If it answers 404 or 410,** `invested` is omitted from every payload — never reported as zero — and the PRD's acceptance line about invested figures is recorded as unfulfilled with evidence rather than faked.

The same split applies to `/loans` and the `loans` figure.

## Domain and contract

`core/account.ts` gains our `Account`, which is not Pluggy's:

```
id, connectionId, institution, name
type: "BANK" | "CREDIT" | "INVESTMENT" | "LOAN"    // superset of Pluggy's, §14.1
subtype: string | null
balanceCents: number, currency: string
lastUpdatedAt: Date | null                          // of the connection, not the account
credit: CreditDetails | null                        // populated only on CREDIT
```

`CreditDetails` carries `limitCents`, `availableLimitCents`, `balanceCloseDate`, `balanceDueDate` and `brand`. It is a nested object rather than five flat optional fields because `exactOptionalPropertyTypes` makes optional members of a readonly type awkward to build conditionally, and because "absence is `null`" is this project's convention — one `null` says "not a card" more clearly than five absent keys do.

**An account type we do not recognize is a parse failure, not a default.** `wire.ts` reads `type` as a bare string, and a fifth value arriving would otherwise either land in the wrong bucket or vanish from every figure and from `accountsCounted` — PRD failure #1 with no error anywhere. So the mapper throws `ResponseShapeError`, which is what that class is for: it means Pluggy changed, not that the request was wrong. This is deliberately the opposite of `Connection.status`, which `core/contracts.ts` argues out loud should stay open — losing a whole connection report to an unknown status is the worse failure there, while silently misfiling money is the worse failure here.

`Bank` in `core/contracts.ts` grows two operations, both scoped to one connection or one account:

```ts
getAccounts(connectionId: string): Promise<readonly Account[]>
getAccount(accountId: string): Promise<Account>
```

**`getAccounts(connectionId)` is two requests, not one.** `GET /accounts?itemId=` does not carry the item's `lastUpdatedAt` — that lives on the item, which is why the recon's freshness table came from `GET /items/{id}`. So the client issues both, in parallel, and merges. The second request is not overhead: it is also what supplies `status` and `executionStatus`, which is how a connection stuck in `UPDATING` becomes visible rather than looking like a healthy one that happens to be empty.

`/accounts` **is paginated**, and offset-paginated at that. The v2 cursor contract replaced §14.2's rule for `/transactions` only; the recon is explicit that "`/accounts`, `/bills` and `/categories` are still offset-paginated and still return `{total, totalPages, page, results}`", and ADR §14.1 lists `/accounts` under the `pageSize = 500` rule. Six accounts fit in one page today and twenty-one will not, and the failure is silent and financial — ADR §14.2 records the prior Go implementation shipping exactly this bug. So the client sends `pageSize=500` and loops to the reported `totalPages`, with a fixture test covering a two-page response.

The fan-out across the configured connections is **not** the client's job. It is a business rule — which connections, what happens when one fails, how the results merge — so it lives in `core/`, and that is what lets the whole partial-failure semantics be tested against `tests/fakes/fake-bank.ts` with no HTTP anywhere.

The fan-out is **concurrent**, via `Promise.allSettled` — which is also the shape that produces the partial-failure result directly. Sequential would multiply latency by the number of connections inside an agent loop for no benefit: the transport's limiter waits rather than rejecting, and its key resolver carries a single-flight guard whose docblock names this exact caller ("so the account fan-out of §14.1 cannot issue N concurrent `POST /auth`"). `init.ts` already fans out with `Promise.all`.

`core/balance.ts` stays pure: `readonly Account[]` in, a per-currency summary out. `BANK` sums into cash, `CREDIT` into owed, `LOAN` into loans, `INVESTMENT` into invested, and no two ever meet in one figure.

**`LOAN` gets its own labelled figure rather than being folded into `owed`.** ADR §14.1 excludes it from *cash* ("a debt is not money you have"), which is not the same as excluding it from the answer. A car loan and a credit card bill are both debt and are not the same obligation — one has a payment schedule, the other closes this month. Folding them would produce the confidently wrong number the PRD ranks first, and dropping the loan silently produces a smaller one. If `/loans` is out of scope after step 0, the key is simply absent.

### The failure taxonomy lives in `core/contracts.ts`

`unavailable[].reason` and `getBalance`'s error text both have to say *why* a connection failed, and `getBalanceByAccount` has to distinguish "unknown account" (readable `isError`) from "Pluggy is down" (protocol error). The typed failures that carry that distinction — `AuthError`, `NotFoundError`, `RateLimitError`, `HttpError`, `ResponseShapeError` — live in `src/pluggy/errors.ts`, which `core/` cannot import (`core-imports-no-infrastructure`) and `mcp/` cannot either (`only-bin-builds-infrastructure`). Left as-is, the fan-out sees `unknown` and reaches for `error.message`, and every per-failure-class decision degrades to string matching.

So the discriminant moves to where both consumers can see it:

```ts
export type BankFailure = {
  readonly kind: "auth" | "unknown-connection" | "rate-limited" | "unavailable" | "no-accounts" | "bad-response";
  readonly message: string;
};
```

`pluggy/errors.ts` gains the mapping from its own classes onto `kind`; `PluggyError` carries the field. This is the half that was always implied — the file's docblock already says the classification exists "because §16.4 requires deciding *per failure* between a protocol error and readable `isError` tool content, and that decision needs something to switch on". Core is the one that has to switch, and until now it had nothing.

`reason` in the tool payload is `{ kind, message }`, so a model gets a stable token and a human gets the sentence.

## The tools

**`getAccounts()`** — no parameters.

```
{ accounts: [...], unavailable: [{ connectionId, kind, message }] }
```

**`getBalance()`**

```
{
  cash: "2000.00",
  owed: "800.00",
  invested: "15000.00",     // absent when no INVESTMENT account exists
  loans: "22000.00",        // absent when no LOAN account exists
  currency: "BRL",
  accountsCounted: 6,
  asOf: [{ connectionId, lastUpdatedAt }]
}
```

`cash`, `owed`, `invested` and `loans` are four labelled figures, exactly as ADR §14.1 decides and PRD Phase 1 accepts. No combined total field exists to be misread. `invested` and `loans` are omitted rather than zeroed when the underlying accounts do not exist — an absent key is a claim we are not making, and `"0.00"` is a claim we cannot support.

`accountsCounted` exists so that "the empty account was counted, not dropped" is an assertable fact rather than an inference. `lastUpdatedAt` travels as ISO-8601 UTC: the recon warns that comparing these as calendar days needs a timezone and that UTC is the wrong one for a Brazilian midnight, so the tool emits the instant and leaves the day arithmetic to whoever has a reason to pick a zone.

**`getBalanceByAccount({ accountId })`** — Zod at the boundary. An unknown id becomes readable `isError` content, never a protocol error.

Every description follows the three-part template of ADR §14.0, including the "Use this tool when" block, because descriptions are the only discovery surface a model gets.

**`getAccounts`' description carries one extra sentence, and it is a deliverable rather than a detail.** The tool hands the model every account's balance, so a model that gets a refused `getBalance` can sum `BANK` and `CREDIT` itself and produce precisely the number this design exists to prevent. The `Returns:` block therefore says, in words: these are per-account figures in different units — a `CREDIT` balance is an unpaid bill, not money held — and consolidating them is what `getBalance` is for.

## Server and composition root

```
src/mcp/
├── server.ts        createServer({ source, version, log }) → McpServer
├── format.ts        cents → decimal string, null/undefined pruning
└── tools/
    ├── accounts.ts  getAccounts + getBalanceByAccount
    └── balance.ts   getBalance
```

`src/mcp/` imports nothing from `src/pluggy/` or `src/storage/` — `.dependency-cruiser.js` enforces `only-bin-builds-infrastructure`, so the injection is checked rather than merely intended. Construction happens in the `serve` branch of `bin/cata-centavo.ts`, beside the `init` branch that already assembles the client the same way.

`serve` opens no SQLite file. With no cache there is nothing to persist.

**`source` is a discriminated union, and it is what makes a broken configuration recoverable.**

```ts
type Source =
  | {
      readonly ok: true;
      readonly connections: readonly string[];
      readonly bank: Bank;
      readonly toFailure: (error: unknown) => BankFailure;
    }
  | { readonly ok: false; readonly problems: readonly string[] };
```

`toFailure` travels with the bank for the same reason the taxonomy exists: `core/` may not import `pluggy/errors.ts`, so the translation from a thrown `unknown` into a `BankFailure` arrives as a parameter. `bin/` injects the real one; a test injects a trivial one.

`Source` lives in its own module, `src/mcp/source.ts`. Putting it in `server.ts` would make `server.ts` and `tools/*.ts` import each other, and `.dependency-cruiser.js` runs with `tsPreCompilationDeps: true` — a type-only import is still an edge, so `no-cycles` fails.

Two things forced this shape. The connection ids have to reach the fan-out from somewhere, and the alternative — `core/` calling `loadConfig(process.env)` — is process-global state read from inside a business rule, untestable and invisible to the dependency rules that would otherwise have caught it. And when `loadConfig` fails there are no credentials, so no client can be constructed, so there is no `Bank` to pass at all; a signature taking a bare `bank` cannot express the state the server is required to start in.

So: refusing to boot produces a client that says "server failed" without saying which variable is missing. Instead the server starts, registers all three tools, and every handler checks `source.ok` first and returns `isError` carrying the problems `loadConfig` already collects — one per line, each naming the variable and how to declare it. PRD rule #4 is exactly this: what the model can recover from has to reach it as readable content.

Capabilities stay minimal: `tools` only, no prompts, no resources.

## One account's balance, and why a 404 is not the test

`getBalanceByAccount` rests on `GET /accounts/{id}`, which is authorized by the API key — and the key covers the whole Pluggy application, not the subset named in `PLUGGY_ITEM_IDS`. An id belonging to an item the user has but has not configured returns **200**. `errors.ts` already says the neighbouring half out loud: a 404 means "wrong id, or an id belonging to another Pluggy account".

Two consequences. The tool cannot rely on Pluggy to tell it an id is unknown, and `Account.connectionId` could otherwise name a connection the user never configured — against ADR §2's posture that the configured set *is* the world. So after fetching, the tool checks the returned account's `itemId` against the configured ids and produces the "unknown account" `isError` itself. That is also the real answer to step 0's third question: `GET /accounts/{id}` working is necessary and not sufficient.

## Observability

The logger already writes to fd 2 and to a rolling file under `XDG_STATE_HOME`; stdout is the JSON-RPC channel and nothing else reaches it.

**Correlation.** Each tool call takes a `log.child({ tool, callId })`. A client may have several requests in flight over stdio, and without this their lines interleave with nothing to separate them. `child()` has been on the `Logger` contract since it was written and has had no caller until now.

**Per call:** `info` on entry with tool and parameters, `info` on exit with `durationMs` and `outcome: "ok" | "tool-error" | "crash"`, `warn` per unavailable connection naming which and why. The fan-out emits one line per connection with its own `durationMs`, which is what answers "why was `getBalance` slow" when three connections are two requests each.

**Levels, not redaction.** An earlier draft of this design forbade monetary values in logs. That was inconsistent with ADR §9, which already accepts that `cache.db` will hold the entire financial history in plaintext — refusing to log a balance while writing every transaction to the cache is the same theatre §9 rejects when it declines to seal the credential.

What survives the correction is narrower and real: the log file is the artifact people paste into a bug report or a chat window, and the cache is not. So balances, account names and response bodies belong at `debug` — the level you turn on precisely when a number came back wrong and you need to see the number — and `info`/`warn` carry shape and counts (`{ accounts: 6, unavailable: 1 }`), because an `info` line holding a whole body makes the log unreadable when it matters. The stderr stream is already at `warn` by default and the file follows `CATA_CENTAVO_LOG_LEVEL`, so this costs no new code, only choosing the level at each call site.

The README gains a sentence: under `CATA_CENTAVO_LOG_LEVEL=debug` the log file holds financial data, in the same section that already has to say it about the cache.

**Credentials stay out at every level.** `clientSecret` and the Pluggy JWT are a different kind of thing — a leaked balance leaks a balance, a leaked credential grants access. `LogFields` already says so, `logging.ts` redacts the paths, and `tests/fakes/fake-logger.ts` is where it is asserted.

**The stdout trap is handled by the linter, not at runtime.** `no-console: "error"` is already configured. It is extended to cover the hole it leaves:

```js
"no-restricted-properties": ["error", {
  object: "process", property: "stdout",
  message: "stdout is the JSON-RPC channel (ADR §4). Human-facing output goes to stderr.",
}]
```

Nothing in `src/` writes stdout legitimately: `say()` in `bin/` already uses `process.stderr.write`, and the protocol is written by the SDK's transport. So the rule needs no exception. It is not a guarantee, and should not be read as one — `const { stdout } = process`, `globalThis.process.stdout` and any aliasing all pass it, as does a dependency writing to fd 1 on its own. A runtime guard — a private stream over fd 1 with `process.stdout.write` repointed at stderr — was considered and dropped: it pays at runtime for the common case that lint catches earlier and for free, and it would not have caught the dependency either.

## Acceptance criteria

### The account map

> As someone with several banks linked, I want to see every account the server can reach, so that I know what the answers below are computed over.

```gherkin
Scenario: Every account across every connection is listed
  Given three connections are configured
  And each connection holds one checking account and one credit card
  When the account map is requested
  Then six accounts are returned
  And each account carries its connection, institution, type and subtype
  And no connection is reported as unavailable

Scenario: One unreachable connection is named rather than hidden
  Given three connections are configured
  And the second connection refuses to answer
  When the account map is requested
  Then the four accounts of the reachable connections are returned
  And the second connection is listed as unavailable with the kind and message it gave
  And the result is not reported as an error

Scenario: Every connection unreachable still answers readably
  Given three connections are configured
  And no connection answers
  When the account map is requested
  Then no accounts are returned
  And all three connections are listed as unavailable with their kinds and messages

Scenario: A connection answering with no accounts is unavailable, not healthy
  Given three connections are configured
  And the second connection answers successfully with an empty account list
  When the account map is requested
  Then the four accounts of the other connections are returned
  And the second connection is listed as unavailable with kind "no-accounts"

Scenario: A stale connection reports when its bank last spoke
  Given a connection whose last successful sync was three days ago
  When the account map is requested
  Then every one of its accounts carries that instant as its last update
  And the accounts are returned rather than withheld

Scenario: An account list spanning two pages is fetched whole
  Given a connection holding more accounts than fit in one page
  When the account map is requested
  Then every account from every page is returned
```

### How much money I have

> As someone asking "quanto eu tenho?", I want cash separated from what I owe, so that a card bill never gets counted as money in my pocket.

```gherkin
Scenario: Cash and debt are reported as separate figures
  Given a checking account holding 1500.00
  And a second checking account holding 500.00
  And a credit card with an open bill of 800.00
  When the consolidated balance is requested
  Then cash is reported as "2000.00"
  And owed is reported as "800.00"
  And the result has no field combining cash and debt

Scenario: A partial answer is refused rather than totalled
  Given three connections are configured
  And the second connection refuses to answer
  When the consolidated balance is requested
  Then the result is an error the model can read
  And the error names the connection that failed and the kind of failure
  And the result has no cash field

Scenario: An empty account is counted, not dropped
  Given a checking account holding exactly 0.00
  And a second checking account holding 300.00
  When the consolidated balance is requested
  Then cash is reported as "300.00"
  And the number of accounts counted is 2

Scenario: Absent investments produce no invested figure
  Given no investment account exists on any connection
  When the consolidated balance is requested
  Then the result has no invested field

Scenario: A loan is reported apart from a card bill
  Given a credit card with an open bill of 800.00
  And a loan account with an outstanding balance of 22000.00
  When the consolidated balance is requested
  Then owed is reported as "800.00"
  And the loans figure is reported as "22000.00"

Scenario: Two currencies are refused rather than added
  Given a checking account holding 1500.00 in BRL
  And a checking account holding 200.00 in USD
  When the consolidated balance is requested
  Then the result is an error the model can read
  And the error names both currencies
  And the result has no cash field
```

### One account's balance

> As someone drilling into a single account, I want its balance alone, so that I can check one bank against its own app.

```gherkin
Scenario: The requested account is the account returned
  Given six accounts exist across the configured connections
  When the balance of a named account is requested
  Then that account's id and balance are returned
  And no other account's figures appear in the result

Scenario: An account outside the configured connections is refused
  Given an account id belonging to a Pluggy connection that is not configured
  And Pluggy answers the request successfully
  When the balance of that account is requested
  Then the result is an error the model can read
  And the error states that the account is unknown
  And no balance appears in the result

Scenario: An unknown account leaves the server able to answer again
  Given an account id that Pluggy does not recognise
  When the balance of that account is requested
  And the account map is requested afterwards
  Then the first result is an error the model can read
  And the second result lists the accounts normally
```

### Configuration, cutting across all three

```gherkin
Scenario: A missing credential is reported through the tool, not by dying
  Given PLUGGY_CLIENT_SECRET is not set in the environment
  When any of the three tools is called
  Then the result is an error the model can read
  And the error names the missing variable and how to declare it
  And all three tools remain listed and callable
```

Fifteen scenarios. Two more are deliberately absent: there is none for a credit card arriving with a negative balance, and none asserting a specific `type` for an investment account, because both are what step 0 exists to determine and writing the criterion now would be guessing which side is right. Both branches of the investments question are specified above, so step 0 chooses between two written outcomes rather than opening a new question.

`The requested account is the account returned` is the regression the prior Go implementation shipped — a parameter parsed, validated and never read. It is PRD rule #3 turned into a test.

## Testing

TDD throughout, red before green.

`core/balance.ts` carries the tests that matter most and needs no I/O: a table of accounts in, a summary out, covering the card-into-cash fold, the loan kept apart from the card, the exactly-zero balance surviving, `invested` absent versus zero, the mixed-currency refusal, and whichever sign step 0 establishes for credit. One table, one loop, one assertion body.

Partial failure is tested end to end without HTTP. `tests/fakes/fake-bank.ts` grows `getAccounts` and `getAccount`, keeping its existing per-id failure map — which already throws the real `NotFoundError`, so callers meet the same classification they will face in production. Three connections with the middle one rejecting asserts that `getAccounts` returns four accounts plus one `unavailable` entry, and that `getBalance` returns `isError` with no `cash` field in the body. The zero-accounts case reuses the same fixture with an empty list instead of a rejection.

**The `accountId`-reaches-the-request test belongs at the handler, not at the transport.** A `fake-fetch` assertion on the URL proves `client.getAccount(id)` builds the right path; the regression PRD rule #3 describes happened *above* that, between Zod and the client, where a handler passes a constant or the wrong field and the fetch-layer test still passes. So the test that matters calls the tool with `{ accountId: "X" }` against a `fake-bank` recording what `getAccount` received — `fake-bank` already records `calls`, so it is nearly free. The transport-level test stays too; they cover different seams.

`pluggy/mapper.ts` is tested against fixtures captured in step 0, with amounts, names and account numbers replaced by synthetic values. The repository is public and PRD open decision #6 is unresolved, so the fixtures are born anonymized. The mapper's `creditLimit − availableCreditLimit` cross-check against `balance` is a test of its own, since it is the guard against `owed` inverting.

`stryker.config.json` gains `src/mcp/format.ts` to its `mutate` list. Its current scope is `src/core/**` and `src/pluggy/**`, which excludes the one function implementing both "strip only `null`/`undefined`, never falsy" and the cents-to-string conversion — exactly where a green-but-assertionless test survives, and exactly what mutation testing exists to catch. The zero-balance Gherkin above exercises `getBalance`, not the serializer, so it would not catch a `0` vanishing on its own.

`npm run mutation` runs at the end, since this phase touches `src/core`, `src/pluggy` and now `src/mcp/format.ts`.

## Wiring into a local Claude Code session

`.mcp.json` at the repository root, committed, holding no secret:

```json
{
  "mcpServers": {
    "cata-centavo": {
      "command": "${CLAUDE_PROJECT_DIR}/scripts/mcp-dev.sh",
      "env": {
        "PLUGGY_CLIENT_ID": "${PLUGGY_CLIENT_ID:-}",
        "PLUGGY_CLIENT_SECRET": "${PLUGGY_CLIENT_SECRET:-}",
        "PLUGGY_ITEM_IDS": "${PLUGGY_ITEM_IDS:-}",
        "CATA_CENTAVO_LOG_LEVEL": "${CATA_CENTAVO_LOG_LEVEL:-info}"
      }
    }
  }
}
```

Project scope, approved once on first use. Values come from `${VAR}` expansion, so the file is safe in a public repository.

**The `:-` defaults are load-bearing.** A bare `${PLUGGY_CLIENT_SECRET}` with the variable unset is an expansion *failure*, not an empty string, and a server entry that fails to expand may never spawn — which means no server, no tools, and none of the readable `isError` the broken-configuration design above exists to produce. The one scenario testing that path tests the handler, so it would stay green while the wiring was broken.

`CATA_CENTAVO_LOG_LEVEL` is the name `logging.ts` actually reads. `LOG_LEVEL` is read nowhere in `src/`.

`scripts/mcp-dev.sh` loads nvm, runs `nvm use` against `.nvmrc`, and `exec`s `src/bin/cata-centavo.ts` — no build step, since Node 24 executes TypeScript directly. When v24.15.0 is missing it dies with a sentence on stderr rather than with `ERR_UNKNOWN_FILE_EXTENSION`.

The wrapper sources a gitignored `.env.local` beside it, if present, before the `exec`, and it fills a variable **only when that variable is unset or empty** — `: "${PLUGGY_CLIENT_ID:=$FROM_FILE}"` semantics. Without the "or empty" half the `:-` defaults above would shadow the file with empty strings and the wrapper would silently do nothing.

This does not contradict ADR §16.2's rejection of auto-loading `.env`: that rejection is about the published binary reading the current working directory under `npx`, which is wherever the user happened to be standing. This is a development script reading a fixed path next to itself, and the shipped product still touches no env file.

Opening Claude from a shell without the variables set is a handled case rather than a broken one — the server starts, the three tools appear, and the first call reports which variable is missing.

The acceptance test for the phase as a whole: reconnect the MCP server in a live session and have `getAccounts` return the six accounts, with connection A showing its stale `lastUpdatedAt`.

## Still open after this phase

- Cache freshness by range, now Phase 2's problem, where a date range first exists.
- Whether `/investments` and `/loans` exist on this connector at all — step 0 answers it, and both branches are specified above.
- The sign of a credit card account balance — step 0 decides it via the credit-limit cross-check.
- Whether account-level monetary fields carry sub-cent noise — step 0 measures it.
- Why a connection returns zero accounts. Phase 1 reports the fact; PRD Phase 5 owns the consent state that explains it.
- Test fixtures without committing real statements (PRD open decision #6). Phase 1 works around it by anonymizing at capture; the general policy is still undecided.

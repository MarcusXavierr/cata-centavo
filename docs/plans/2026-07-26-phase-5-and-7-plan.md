# Phases 5 and 7 — `listSources`, `doctor` and the README: implementation plan

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task.

**Goal:** Ship `listSources` as the ninth MCP tool, make an empty response tell the truth about revoked consent, and land `doctor` and a README a stranger can install from.

**Architecture:** Consent enters at `src/pluggy/` as a wire schema and one client method, and leaves as a domain `Consent`. The verdict — active, revoked, expired, unknown — is a pure function in `src/core/consent.ts`. `listSources` and `doctor` read the same thing, so one function in `src/core/diagnose.ts` serves both: `src/mcp/tools/sources.ts` renders it for a model, `src/cli/doctor.ts` renders it for a human and adds what is on disk. Only `src/bin/` constructs infrastructure.

**Tech Stack:** Node 24 (native TypeScript stripping), `@modelcontextprotocol/sdk`, `zod`, `pino`, `node --test`, Stryker.

**Design:** `docs/plans/2026-07-26-phase-5-and-7-design.md`. Read it before Task 1. Where this plan and the design disagree, the design wins.

**Scope note:** Phase 4 (`getBills`, `getBillSummary`, `manageClosingDate`) and Phase 6 (`getInstallments`) are being built on a parallel branch. Nothing in this plan touches them. The README names them by capability only — no parameters, no return shapes — so it cannot drift out of sync with a signature this branch has never run.

---

## Before you start

Every command block assumes you have run `nvm use` in that shell. Node 18 is this machine's default and it fails misleadingly: one test file dies with `ERR_UNKNOWN_FILE_EXTENSION`, and `npm test` reports `# tests 0` and exits 0 — a green run that executed nothing.

```bash
nvm use    # reads .nvmrc → v24.15.0
node -v    # must print v24.15.0
```

**The validation sequence, in this order, after every task:**

```bash
npm run typecheck && npm run lint && npm run deps && npm test
```

Order matters. Node strips types without checking them, so `tsc` is the only type checking that exists; `deps` is the architecture rule enforcement, and it will catch a forbidden import before a reviewer does.

**TDD, always.** Red before green, in every task below that has a test line. The failing test is written first and run first.

**Compiler flags that will bite you.** `erasableSyntaxOnly` (no `enum`, no parameter properties — use a `const` object plus a derived union, as in `src/cli/dispatch.ts`), `noUncheckedIndexedAccess` (`array[0]` is `T | undefined`), `exactOptionalPropertyTypes` (you cannot assign `undefined` into an optional field). Source files import with `.ts` extensions. Nothing but JSON-RPC may reach stdout, in any mode.

**On commits:** this repository's `CLAUDE.md` says do not commit unless asked.

---

## Task 1: The consent wire schema

**Files:**
- Modify: `src/pluggy/wire.ts`
- Modify: `tests/pluggy/wire.test.ts`
- Create: `tests/fixtures/consent.json`

Add `CONSENT_PAGE`, the paged envelope of `GET /consents?itemId=`, following the `ACCOUNT_PAGE` pattern already in the file:

```ts
export const CONSENT = z.object({
  id: z.string().min(1),
  expiresAt: z.string().nullish(),
  revokedAt: z.string().nullish(),
  products: z.array(z.string()).nullish(),
});

export const CONSENT_PAGE = z.object({
  results: z.array(CONSENT),
  total: z.number(),
  totalPages: z.number(),
  page: z.number(),
});
```

**The consent's own `itemId` must not enter the schema.** `docs/research/2026-07-26-phase-0-5-recon.md` §"`GET /consents?itemId=` returns a consent belonging to a different item" found that it carries the UUID of the inner MeuPluggy item — a different one on each of the three connections, none matching a configured id. Reading it only creates the temptation to perform the join that would silently produce zero matches. Record that in a docblock above `CONSENT`: this is the kind of omission somebody "fixes" six months later.

Same file: `ITEM` gains `consecutiveFailedLoginAttempts: z.number().nullish()`.

The fixture is hand-written rather than captured. The repo is public, and no real revoked consent has been observed anyway — all three in the recon came back `expiresAt: null`, `revokedAt: null`.

**Tests:** `CONSENT_PAGE` parses a real-shaped body; an unknown extra key is dropped rather than rejected; `ITEM` still parses without `consecutiveFailedLoginAttempts`.

---

## Task 2: The domain type and the verdict

**Files:**
- Modify: `src/core/contracts.ts`
- Create: `src/core/consent.ts`
- Create: `tests/core/consent.test.ts`

In `contracts.ts`:

```ts
/** An Open Finance consent, as far as our domain is concerned. */
export type Consent = {
  readonly expiresAt: Date | null;
  readonly revokedAt: Date | null;
  readonly products: readonly string[];
};
```

`Bank` gains `getConsent(connectionId: string): Promise<Consent | null>`. `Connection` gains `failedLogins: number | null`. `FailureKind` gains `"consent-revoked"` and `"consent-expired"`.

`null` from `getConsent` means the endpoint answered with no consent at all. That is distinct from revoked, and the distinction is load-bearing: **we never report "revoked" from absence.**

`src/core/consent.ts` holds the verdict, here rather than at the boundary because it needs the clock:

```ts
export type ConsentState = "active" | "revoked" | "expired" | "unknown";

export function consentState(consent: Consent | null, now: Date): ConsentState;
```

`revoked` takes precedence over `expired` when both apply. Revocation is an act and expiry is the clock running out; the act is what the user has to answer for.

**Tests:** a table over active, revoked, expired, both (revoked wins), `null` → unknown, and the boundary where `expiresAt` is exactly `now`.

---

## Task 3: The client, the mapper and the fake

**Files:**
- Modify: `src/pluggy/client.ts`, `src/pluggy/mapper.ts`
- Modify: `tests/fakes/fake-bank.ts`
- Modify: `tests/pluggy/client.test.ts`

`getConsent` on the client uses the private `get<T>(path, schema, describe)` helper already in `createPluggyClient`, so the rate limiter, the 429 backoff and the error-envelope parsing all apply without being remembered. It returns `null` when `results` is empty, and maps the first result otherwise. Date strings become `Date` here, because this is the file that knows dates arrive as strings.

`toConnection` in `mapper.ts` carries `failedLogins: item.consecutiveFailedLoginAttempts ?? null`. `statusDetail` is already reduced to `warnings` by `toWarnings`, and that reduction is what §14.6 means in practice by reporting `statusDetail`, so nothing else in the mapper changes.

`fakeBank` gains `getConsent`, and `FakeBankOptions` gains `consents?: Readonly<Record<string, Consent | null>>`. An id with no entry answers `null`; the `unreachable` mechanism already in the fake covers the throwing case.

**Tests:** `getConsent` requests `/consents?itemId=`; an empty `results` yields `null`; `consecutiveFailedLoginAttempts` reaches `Connection.failedLogins`, including when the field is absent from the body.

---

## Task 4: Pitfall #7 in `collectAccounts`

**Files:**
- Modify: `src/core/accounts.ts`
- Modify: `src/mcp/tools/accounts.ts`, `src/mcp/tools/balance.ts` (call sites only)
- Modify: `tests/core/accounts.test.ts`

`collectAccounts` takes the `Clock` as a fourth parameter — it is already in `ToolDeps`, so both call sites have one to hand. The empty branch stops guessing:

```ts
if (result.value.length === 0) {
  unavailable.push(await diagnoseEmpty(bank, connectionId, clock));
  continue;
}
```

`diagnoseEmpty` calls `bank.getConsent(connectionId)` and maps through `consentState`:

| state | kind | message |
|---|---|---|
| `revoked` | `consent-revoked` | names the date, tells the user to re-link |
| `expired` | `consent-expired` | names the date |
| `active`, `unknown` | `no-accounts` | today's message **minus** the clause "revoked consent is the usual cause" |

That clause comes out under `active` because it is now known to be false. Leaving a guess in place next to a check that disproved it is worse than never having guessed.

**If the consent lookup itself throws, fall back to `no-accounts`.** A diagnostic query that breaks must not turn a mild "no accounts" into a crash — it exists to explain, not to bring the call down.

**Tests:** empty + revoked → `consent-revoked` carrying the date; empty + active → `no-accounts` without the consent clause; empty + a consent lookup that throws → `no-accounts` and no rejection; a connection with accounts never calls `getConsent` at all.

---

## Task 5: The loudness rule in `getAccounts`

**Files:**
- Modify: `src/mcp/tools/accounts.ts`
- Modify: `tests/mcp/tools/accounts.test.ts`

Today `getAccounts` with every connection dead returns `{accounts: [], unavailable: [...]}` in an ordinary `textResult`. An agent that asked "how much do I have?" gets an empty list and a note it may not read — which is pitfall #7 happening inside our own response.

**Zero accounts in total *and* at least one unavailable connection → `isError: true`**, with the reasons in the text, through the existing `finishToolError`. One connection alive and another revoked stays an ordinary result with `unavailable` filled, because the numbers that did come back are real.

The rule covers every `kind`, not only consent. Restricting it to consent would leave "credentials refused everywhere" reporting a balance of zero.

**`src/mcp/tools/balance.ts` needs no change to its error policy.** It already returns `isError` whenever *any* connection is unavailable, which is stricter than this rule. It only inherits the truer `kind` and `message` from Task 4.

**Tests:** all connections unavailable → `isError` with every reason in the text; one alive and one dead → ordinary result, `unavailable` populated; zero connections configured and zero unavailable → unchanged behaviour.

---

## Task 6: `core/diagnose.ts`

**Files:**
- Create: `src/core/diagnose.ts`
- Create: `tests/core/diagnose.test.ts`

```ts
export type ConnectionDiagnosis = {
  readonly id: string;
  readonly connection: Connection | null;
  readonly failure: BankFailure | null;
  readonly consent: Consent | null;
  readonly state: ConsentState;
};

export async function diagnose(
  bank: Bank,
  connectionIds: readonly string[],
  toFailure: (error: unknown) => BankFailure,
  clock: Clock,
): Promise<readonly ConnectionDiagnosis[]>;
```

Per connection, `getConnection` and `getConsent` fire together and settle **independently**. A consent lookup that fails must not take the item status with it, and the reverse holds too: they are two halves of a diagnosis and each is worth having alone.

Output order follows the order of `connectionIds`, so the report lines up with what the user typed into `PLUGGY_ITEM_IDS`. One bad id does not abort the rest — the same discipline `check()` in `src/cli/init.ts` already follows.

Two requests per connection. Six for the recon's three, against a limit of 360/min.

**Tests:** item ok / consent fails → `connection` set, `consent` null, `state` unknown; item fails / consent ok → `failure` set and the consent still reported; output order follows input; one failed id does not abort the rest.

---

## Task 7: `listSources`

**Files:**
- Create: `src/mcp/tools/sources.ts`
- Modify: `src/mcp/server.ts`
- Create: `tests/mcp/tools/sources.test.ts`

`registerListSources`, no input, description on the three-part template. Per connection: `id`, `institution`, `status`, `executionStatus`, `lastUpdatedAt`, `warnings`, the `parameter` the bank is waiting on, `failedLogins`, and `consent { state, expiresAt, revokedAt, products }`. `prune` strips only `null`/`undefined`, so `failedLogins: 0` survives — a zero disappearing here is the same class of bug as a zero balance disappearing.

**`listSources` never returns `isError` because of connection state.** This inverts Task 5 deliberately. `getAccounts` errors when it cannot answer; for `listSources`, a broken connection *is* the answer, and erroring at the moment everything is rotten would hide the very diagnosis the agent came for. Only missing configuration produces `isError`, through the existing `configurationProblems` path.

The description carries pitfall #8 explicitly: **this lists what is configured, not what exists in your Pluggy account.** No endpoint enumerates the items on an account (§2), so a connection whose UUID never reached the config is invisible here. Without that sentence the model asserts complete coverage over a list it cannot know is complete.

`registerListSources` joins `REGISTRARS` in `server.ts`. Nine tools.

**Tests:** every field reaches the response, including `failedLogins: 0` and an empty `warnings`; a revoked consent renders `state: "revoked"` and is **not** `isError`; every connection failing is still not `isError`; missing configuration is.

**Phase 5 ships at the end of this task.**

---

## Task 8: `storage/diagnostics.ts`

**Files:**
- Create: `src/storage/diagnostics.ts`
- Create: `tests/storage/diagnostics.test.ts`

```ts
export type LocalState = {
  readonly cacheVersion: number;
  readonly dataVersion: number;
  readonly accountsWalked: number;
  readonly newestLocalDate: string | null;
  readonly perConnection: ReadonlyMap<string, { accounts: number; oldestWalk: string | null }>;
  readonly snapshotRows: number;
  readonly counterpartyDocuments: number;
  readonly mccRows: number;
};

export function readLocalState(db: DatabaseSync): LocalState;
```

`accountsWalked` and `perConnection` come from `transaction_sync`, which already carries `connection_id` — so the per-connection cache picture costs no network fan-out at all. `newestLocalDate` is `MAX(local_date)` over `transactions`. The last three count `userdata.category_snapshot`, `userdata.counterparty_categories` and `mcc_categories`. Reuse `schemaVersion(db, schema)` from `src/storage/db.ts` for the two versions.

**An empty database reads as zeroes, never a throw.** `doctor` runs precisely when things are broken; a diagnostic that crashes on a fresh install is worse than useless.

**Tests:** `:memory:` via `openDatabase({ path: ":memory:", migrations: CACHE_MIGRATIONS, policy: "rebuild" })`, which attaches `userdata` and runs the data migrations automatically. Counts on a populated database; grouping across two connections; a fresh database returning zeroes and `null`.

---

## Task 9: `cli/doctor.ts`

**Files:**
- Create: `src/cli/doctor.ts`
- Create: `tests/cli/doctor.test.ts`

Mirrors `src/cli/init.ts`: a pure `runDoctor(deps)` returning a discriminated report, `formatDoctor(report, clock)` returning lines for stderr, and `exitCodeFor(report)`. Nothing in `cli/` constructs infrastructure — `bin/` builds the dependencies, which `.dependency-cruiser.js` enforces as the composition-root rule.

```ts
export type DoctorDeps = {
  readonly env: Env;
  readonly createBank: (credentials: Credentials) => Bank;
  readonly readLocalState: () => LocalState;
  readonly clock: Clock;
};
```

`readLocalState` opens both databases the way `serve` does, reads, and closes. That runs migrations, so `doctor` is not strictly read-only against our own disk. The alternative is a second open mode existing only for this command, and it is not worth it; the report says which versions it found, which is the interesting part either way.

Four blocks on stderr:

```
connections
  ! 1a2b…  MeuPluggy  UPDATED  synced 3d ago
           consent: active, 9 products
           1 product could not be updated: CREDIT_CARDS
  ✓ 3c4d…  MeuPluggy  UPDATED  synced 2h ago
           consent: active, 9 products
  ✗ 5e6f…  — consent revoked on 2026-07-20; re-link this connection

storage
  ✓ cache  v2  /home/…/.cache/cata-centavo/cache.db
  ✓ data   v1  /home/…/.local/share/cata-centavo/data.db

cache
  6 accounts walked, newest transaction 2026-07-25
  1a2b…  2 accounts, oldest walk 3d ago

categorization
  snapshot      1748 transactions
  counterparty   312 documents
  merchant codes present

2 of 3 connections are usable
```

The `categorization` block is the part §14.6 does not literally ask for, and it is the reason to run `doctor` when the connections are fine. The README's own asymmetry section says the learned map starts empty for anyone who installs after their enrichment stopped; nothing today tells a user which side of that line they are on. Three counts do.

Reuse `describeSync` from `init.ts` — extract it rather than copying it, since both commands now render "synced 3d ago" and a second copy will drift.

**Exit codes:** `2` for missing configuration, matching `init`. `1` when storage is unreadable, credentials are refused, or any connection cannot be read or has a revoked or expired consent. `0` otherwise.

**A stale sync is a warning line and exits `0`.** The recon found a connection stalled three days at `status: UPDATED`, with no error and no `statusDetail`, and nothing in the item payload distinguishes "not scheduled yet" from "will never sync again". Failing on it would fail on a condition we cannot diagnose and the user cannot fix.

**Tests:** the report shape for each branch; the formatted lines; every exit code. Follow the `deps()` helper pattern in `tests/cli/init.test.ts`, with `fixedClock` for the relative times.

---

## Task 10: Wiring, verified by hand

**Files:**
- Modify: `src/bin/cata-centavo.ts`

The stub branch — `[stub] command "…" is not implemented yet` — goes. `doctor` joins `init` and `serve` in `run()`, resolving paths and building deps the way the `init` branch already does.

```bash
npm run dev -- doctor
npm run dev -- doctor 1>/dev/null     # the whole report must still appear
npm run dev -- init                   # still passes
echo $?
```

The second command is the one that matters: it proves nothing reached stdout. The third proves the `collectAccounts` signature change and the new `Connection` field did not break onboarding.

---

## Task 11: The README

**Files:**
- Modify: `README.md`

Replace the file, keeping today's "Categories, and one asymmetry worth knowing about" section almost verbatim. It is the best-written thing in the repo's prose and covers ground nothing else does.

```
# cata-centavo            one paragraph: what it is, who it is for
## What it does           13 tools, grouped by intent
## Requirements           Node 24, a Pluggy account, connections linked in MeuPluggy
## Install and configure  the three env vars, and the MCP client "env" block
## Commands               init · doctor · default (stdio server)
## How categories work    today's asymmetry section, kept
## What it cannot see     pitfall #8 and the freshness limits
## Security               §9, stated rather than assumed
```

**The tools,** grouped by what the user wants rather than by module: accounts and balances (`getAccounts`, `getBalance`, `getBalanceByAccount`) · spending (`getTransactions`, `listTransactions`, `getTransactionDetails`) · credit cards (`getBills`, `getBillSummary`, `getInstallments`, `manageClosingDate`) · categories (`setCategory`, `setCounterpartyCategory`) · diagnostics (`listSources`).

One line each, describing **what it answers in domain terms** — no parameters, no return shapes. The exact surface is published by each tool's own MCP description, which is where a model reads it and where it cannot drift out of sync. The four credit-card tools are on a parallel branch, and §14.3's `operation`-enum question is still open, so a README documenting their signatures would be asserting something this branch has never run.

**What it cannot see** — three limits, each with its reason:

- A bank linked in MeuPluggy whose UUID never reached `PLUGGY_ITEM_IDS` is invisible. No endpoint lists the items on an account (§2), so this is unfixable in software rather than an oversight. Compare `doctor`'s list against the banks you know you linked.
- Freshness is Pluggy's schedule, not ours. Connector 200 refuses on-demand refresh, so there is no "sync now". One of the author's three connections went three days without syncing while reporting `UPDATED`, with no error to explain it.
- A credit card's `usedCredit` is not what the card owes this month. It mixes the cycle in progress with instalments not yet charged and will not match a banking app.

**Security,** from §9, stated rather than assumed: credentials come from the environment and are never written to disk, so there is no config file and no key file; `cache.db` and `data.db` are plaintext SQLite at `0600`, because encrypting the credential while the full financial history sits in plaintext beside it is theatre, and `node:sqlite` has no SQLCipher; **anyone who can read files as your user — or as root — has your complete financial history**, and `0600` stops a second unprivileged account on the same machine and nothing else; no OS keychain, deliberately, because it costs a native module and a per-platform build matrix against §10; `CATA_CENTAVO_LOG_LEVEL=debug` writes financial data to the log file.

Run the prose through the `humanizer` skill before it lands.

---

## Task 12: Mutation testing and the ADR amendment

```bash
npm run mutation
```

`core/` and `pluggy/` both changed, which is the trigger the testing rules name. Read the survivors and either write the missing assertion or suppress with a reason (`// Stryker disable next-line <Mutator>: why`). It never fails the build; that is the point of reading it.

Amend `docs/adr/0001-stack-and-architecture.md` §15 Phase 5 and Phase 7 in the style of the existing dated amendments, recording what shipped and the two inversions worth writing down: `getAccounts` errors on total emptiness while `listSources` never does, and `doctor` warns rather than fails on a stalled sync. Update §14.7's inventory row for `listSources`.

---

## What this phase deliberately does not do

**It does not prove the shape of a revoked consent.** All three consents in the recon came back `expiresAt: null`, `revokedAt: null` — `docs/research/2026-07-26-phase-0-5-recon.md` says so plainly, and lists it among the things the capture could not observe. Every test here proves our rule against our own fixture, not against the shape Pluggy actually sends. If revocation signals itself some other way — a 403, an empty `results`, a `status` field we did not model — this code reports `active` and pitfall #7 stays open. Worth a capture the day a consent is actually revoked.

**It does not mitigate pitfall #8.** A bank connected in MeuPluggy whose UUID never reached the config is, under §2, unobservable. `listSources` enumerates the config; an item absent from the config is definitionally invisible to it. What ships is the raw material for a user to notice the gap themselves, plus a README that says so.

**It does not check consent on every read.** Only a connection that answers with zero accounts triggers the lookup. Empty transactions over a date range are legitimate, and so are empty bills (§14.3); making either one a consent trigger would spend a request per empty range to answer a question that was not asked.

**It does not touch freshness.** There is no `fresh(accountId, from, to)` here and no lazy cache path. Phase 1 settled that we report freshness rather than control it, and nothing in this phase changes what we can know.

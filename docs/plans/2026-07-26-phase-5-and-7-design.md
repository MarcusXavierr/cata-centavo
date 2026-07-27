# Phases 5 and 7 — `listSources`, `doctor`, and the README

Date: 2026-07-26 · ADR §15 Phase 5 and Phase 7

## What is left of these two phases

Phase 5 shrank twice. `manualUpdate` moved to Phase 0 and was then deleted outright, because connector 200 refuses `PATCH /items/{id}` unconditionally. What remains is `listSources` and pitfall #7: an empty response has to be checked against consent and fail loudly rather than report "no transactions".

Phase 7 is `doctor` as specified in §14.6, and the README — a first-class deliverable under §1, required to state the security posture of §9 and to carry pitfall #8 as an operational warning.

Nothing about consent exists in the code today: no `fetchConsents` in the client, no schema in `wire.ts`, no field on `Connection`. `doctor` is already in `COMMANDS` and falls through to the stub in `bin/cata-centavo.ts`. The README is sixteen lines.

## The shape that holds both phases together

`listSources` and `doctor` read the same thing. Both enumerate the configured connections, read item status and consent, and report. The difference is the channel and what `doctor` adds on top.

So: one function in `core/`, two renderers.

```
core/diagnose.ts
    diagnose(bank, connectionIds, toFailure, clock) -> ConnectionDiagnosis[]

mcp/tools/sources.ts  -> listSources, MCP shape
cli/doctor.ts         -> + schema versions, cache state, categorization state
                         -> stderr lines
```

The rule for "consent is revoked or expired" is written once, in `core/consent.ts`, and both callers read it.

---

## 1. Consent at the Pluggy boundary

`wire.ts` gains `CONSENT_PAGE`, the paged envelope of `GET /consents?itemId=`, with `results: [{ id, expiresAt, revokedAt, products }]`.

The consent's own `itemId` field **does not enter the schema**. `docs/research/2026-07-26-phase-0-5-recon.md` found that it carries the UUID of the inner MeuPluggy item, different from the one queried, on all three connections. Reading it only creates the temptation to perform the join that would silently produce zero matches. A docblock records why the field is missing, because that is the kind of omission somebody "fixes" six months later.

`contracts.ts` gains the domain type and one method on `Bank`:

```ts
export type Consent = {
  readonly expiresAt: Date | null;
  readonly revokedAt: Date | null;
  readonly products: readonly string[];
};

// on Bank:
getConsent(connectionId: string): Promise<Consent | null>;
```

`null` means the endpoint answered with no consent at all — distinct from revoked, and the distinction matters: we never report "revoked" from absence.

The verdict lives in `core/consent.ts`, because it needs the clock:

```ts
export type ConsentState = "active" | "revoked" | "expired" | "unknown";

export function consentState(consent: Consent | null, now: Date): ConsentState;
```

`unknown` covers `consent === null`. `revoked` takes precedence over `expired` when both apply: revocation is an act, expiry is the clock running out, and the act is what the user has to answer for.

`ITEM` in `wire.ts` gains `consecutiveFailedLoginAttempts` as `z.number().nullish()`, and `Connection` exposes it. `statusDetail` is already parsed and reduced to `warnings` by the mapper; that reduction is what §14.6 means in practice by "statusDetail", so the mapper is unchanged.

`FailureKind` gains `"consent-revoked"` and `"consent-expired"`.

### What this design cannot prove

All three consents in the recon came back `expiresAt: null`, `revokedAt: null`. The shape of a revoked consent is unobserved. Every test here proves our rule against our own fixture, not the shape Pluggy actually sends. If a revoked consent turns out to signal itself some other way — a 403, an empty `results`, a `status` field we did not model — this code reports `active` and pitfall #7 stays open. Worth a follow-up capture the day a consent is actually revoked.

---

## 2. Pitfall #7 — when "no accounts" is a lie

`collectAccounts` takes the `Clock` (already present in `ToolDeps`) and replaces the guess in its empty branch with a diagnosis:

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
| `active`, `unknown` | `no-accounts` | today's message, minus the guess about consent |

Today's message ends with "revoked consent is the usual cause". Under `active` that clause is now known to be false and comes out.

If the consent lookup itself fails, the result falls back to `no-accounts`. A diagnostic query that breaks must not turn a mild "no accounts" into a crash — it exists to explain, not to bring the call down.

`getConsent` joins `fakeBank`, and `FakeBankOptions` gains `consents?: Record<string, Consent | null>`.

### The loudness rule

Today `getAccounts` with every connection dead returns `{ accounts: [], unavailable: [...] }` in an ordinary `textResult`, no `isError`. An agent that asked "how much do I have?" gets an empty list and a note it may not read — which is pitfall #7 happening inside our own response.

The fix: **zero accounts in total *and* at least one unavailable connection → `isError: true`**, with the reasons in the text. With one connection alive and another revoked, the response stays ordinary and `unavailable` carries the gap, because the numbers that did come back are real.

This applies to every `kind`, not only consent. Restricting it to consent would leave "credentials refused everywhere" reporting a balance of zero.

`getBalance` aggregates over the same `collectAccounts` and inherits the rule.

---

## 3. `core/diagnose.ts` and `listSources`

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

Per connection, `getConnection` and `getConsent` fire together and settle **independently**. A consent lookup that fails must not take the item status with it, and the reverse holds too: they are the two halves of the diagnosis and each is worth having alone.

Output order is the order of `PLUGGY_ITEM_IDS`, so the report lines up with what the user typed. One bad id does not abort the rest — the same discipline `init` already follows.

Two requests per connection. With the three connections of the recon, six, against a limit of 360/min.

### The tool

`mcp/tools/sources.ts` registers `listSources` with no input. Per connection it returns `id`, `institution`, `status`, `executionStatus`, `lastUpdatedAt`, `warnings`, the `parameter` the bank is waiting on, `failedLogins`, and `consent { state, expiresAt, revokedAt, products }`. `prune` strips only `null`/`undefined`, so `failedLogins: 0` survives.

**`listSources` never returns `isError` because of connection state.** This inverts section 2 deliberately. `getAccounts` errors when it cannot answer; for `listSources`, a broken connection *is* the answer. Returning `isError` at the moment everything is rotten would hide the very diagnosis the agent came for. Only missing configuration produces `isError`, following the existing `configurationProblems` path.

The description carries pitfall #8 explicitly: this lists what is **configured**, not what exists in the Pluggy account. Without that sentence the agent asserts complete coverage over a list that, under §2, it has no way to know is complete.

`REGISTRARS` in `server.ts` gains `registerListSources` — nine tools running.

---

## 4. `doctor`

`src/cli/doctor.ts` mirrors the shape of `init.ts`: a pure `runDoctor(deps)` returning a report, a `formatDoctor(report, clock)` returning lines, and an `exitCodeFor`. Nothing in `cli/` constructs infrastructure — `bin/cata-centavo.ts` builds the dependencies, which is what `.dependency-cruiser.js` enforces.

```ts
export type DoctorDeps = {
  readonly env: Env;
  readonly createBank: (credentials: Credentials) => Bank;
  readonly readLocalState: () => LocalState;
  readonly clock: Clock;
};
```

`readLocalState` opens both databases exactly the way `serve` does, reads, and closes. That runs migrations, so `doctor` is not strictly read-only against our own disk; the alternative is a second open mode existing only for this command, which is not worth it. The report says which versions it found, which is the interesting part either way.

### What it reads from disk

New: `src/storage/diagnostics.ts`.

```ts
export type LocalState = {
  readonly cacheDb: string;
  readonly dataDb: string;
  readonly cacheVersion: number;
  readonly dataVersion: number;
  readonly accountsWalked: number;
  readonly newestLocalDate: string | null;
  readonly perConnection: ReadonlyMap<string, { accounts: number; oldestWalk: string | null }>;
  readonly snapshotRows: number;
  readonly counterpartyDocuments: number;
  readonly mccRows: number;
};
```

`accountsWalked` and `perConnection` come from `transaction_sync`, which already carries `connection_id` — so the per-connection cache picture costs no network fan-out. `newestLocalDate` is `MAX(local_date)` over `transactions`. The last three count `userdata.category_snapshot`, `userdata.counterparty_categories` and `mcc_categories`.

Those three are the part §14.6 does not literally ask for, and they are the reason to run `doctor` at all when the connections are fine. The README's own asymmetry section says the learned map starts empty for anyone who installs after their enrichment stopped. Nothing today tells the user which side of that line they are on. Three counts do.

### Output

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

Stderr, always. Nothing but JSON-RPC reaches stdout, and that holds in every mode (§4).

### Exit codes

`2` for missing configuration, matching `init`. `1` when storage is unreadable, when credentials are refused, or when any connection cannot be read or has a revoked or expired consent. `0` otherwise.

A stale sync is a warning line and exits `0`. The recon found one connection stalled three days with `status: UPDATED`, no error and no `statusDetail`, and nothing in the item payload distinguishes "not scheduled yet" from "will never sync again". Failing on it would fail on a condition we cannot diagnose and the user cannot fix.

`bin/cata-centavo.ts` loses its stub branch: `doctor` joins `init` and `serve` in `run()`.

---

## 5. The README

Sixteen lines today, of which the categories section is worth keeping almost verbatim — it is the best-written thing in the file and covers ground nothing else does.

### Structure

```
# cata-centavo
   one paragraph: what it is and who it is for

## What it does
   13 tools, grouped by what the user wants, not by module

## Requirements
   Node 24, a Pluggy account, connections already linked in MeuPluggy

## Install and configure
   the three environment variables, and the MCP client "env" block —
   an MCP client does not read your shell profile

## Commands
   init · doctor · default (stdio server)

## How categories work
   today's asymmetry section, kept

## What it cannot see
   pitfall #8, and the freshness limits

## Security
   §9, stated rather than assumed
```

### The tools

Grouped as: accounts and balances (`getAccounts`, `getBalance`, `getBalanceByAccount`), spending (`getTransactions`, `listTransactions`, `getTransactionDetails`), credit cards (`getBills`, `getBillSummary`, `getInstallments`, `manageClosingDate`), categories (`setCategory`, `setCounterpartyCategory`), diagnostics (`listSources`).

Each gets one line describing **what it answers, in domain terms** — no parameters, no return shapes. Two reasons. The exact surface is published by each tool's own MCP description, which is where a model reads it and where it cannot drift out of sync. And the four credit-card tools are being built on a parallel branch: a README that documented their parameters would be asserting a signature this branch has never run, and §14.3's `operation`-enum question is still open, which is exactly where `getBillSummary` may still change shape.

### What it cannot see

Three honest limits, each with its reason:

- **A bank linked in MeuPluggy whose UUID never reached `PLUGGY_ITEM_IDS` is invisible.** No endpoint lists the items on an account (§2), so this is unfixable in software, not an oversight. Compare `doctor`'s list against the banks you know you linked.
- **Freshness is Pluggy's schedule, not ours.** Connector 200 refuses on-demand refresh, so there is no "sync now". One of the author's three connections went three days without syncing, reporting `UPDATED`, with no error to explain it.
- **A credit card's `usedCredit` is not what the card owes this month.** It mixes the cycle in progress with instalments not yet charged, and will not match the number in a banking app.

### Security

Straight from §9, stated rather than assumed:

- Credentials come from the environment and are never written to disk. There is no config file and no key file.
- `cache.db` and `data.db` are plaintext SQLite at `0600`. Encrypting the credential while the full financial history sits in plaintext beside it would be theatre, and `node:sqlite` has no SQLCipher.
- **Anyone who can read files as your user — or as root — has your complete financial history.** `0600` stops a second unprivileged account on the same machine. It stops nothing else.
- No OS keychain, deliberately: it costs a native module and a per-platform build matrix, against §10.
- `CATA_CENTAVO_LOG_LEVEL=debug` writes financial data to the log file.

Prose goes through the `humanizer` skill before it lands.

---

## Testing

TDD throughout; the failing test comes first.

| File | What it proves |
|---|---|
| `tests/core/consent.test.ts` | table over `consentState`: active, revoked, expired, both (revoked wins), `null` → unknown, boundary at exactly `now` |
| `tests/core/accounts.test.ts` | extended: empty + revoked → `consent-revoked`; empty + active → `no-accounts` without the consent clause; empty + consent lookup throws → `no-accounts`, no crash |
| `tests/core/diagnose.test.ts` | item ok / consent fails and the reverse; order follows the input; one failed id does not abort the rest |
| `tests/mcp/tools/sources.test.ts` | every field reaches the response including `failedLogins: 0`; broken connections never produce `isError`; missing config does |
| `tests/mcp/tools/accounts.test.ts` | extended: all connections unavailable → `isError`; one alive → ordinary result with `unavailable` filled |
| `tests/cli/doctor.test.ts` | report shape, formatted lines, and every exit code |
| `tests/storage/diagnostics.test.ts` | `:memory:` with the two-file `ATTACH`: counts, per-connection grouping, empty database reads as zeroes rather than throwing |
| `tests/pluggy/wire.test.ts` | `CONSENT_PAGE` parses a real-shaped body; an unknown extra key is dropped |
| `tests/pluggy/client.test.ts` | `getConsent` hits `/consents?itemId=`, returns `null` on empty `results`, and the item's `consecutiveFailedLoginAttempts` reaches `Connection` |

A consent fixture goes in `tests/fixtures/`, hand-written rather than captured, since the repo is public and no real revoked consent has been observed anyway.

`npm run mutation` runs at the end — `core/` and `pluggy/` both change here, which is exactly the trigger §"Testing" names.

## Order of work

1. Consent at the boundary: `wire.ts`, `client.ts`, `contracts.ts`, `core/consent.ts`, `fakeBank`.
2. Pitfall #7 in `collectAccounts`, plus the `isError` loudness rule in `getAccounts` and `getBalance`.
3. `core/diagnose.ts` and `listSources`, wired into `REGISTRARS`.
4. `storage/diagnostics.ts`, `cli/doctor.ts`, and the stub branch removed from `bin/`.
5. The README.

Steps 1 to 3 are Phase 5 and ship on their own. Steps 4 and 5 are Phase 7.

Gate after each step: `npm run typecheck` → `npm run lint` → `npm run deps` → `npm test`.

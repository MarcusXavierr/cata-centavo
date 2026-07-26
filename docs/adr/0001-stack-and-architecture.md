# ADR 0001 — Stack, architecture and distribution

Date: 2026-07-25
Status: **accepted in its foundations, open in its scope.**

The engineering decisions (§3–§11) are settled and evidence-backed. The categorization scope (§12) and the roadmap ordering (§15) still carry blocking questions: §13 lists two open decisions, §12.12 four more, §14.3 one, and "Branches not yet walked" five — two of which block Phase 0 and Phase 1. **Do not read this document as ready to execute end to end.** Phases 0 and 0.5 are safe to start; everything from Phase 2 onward depends on questions this ADR names but does not answer.

**Amendment, 2026-07-25 — Phase 0 unblocked, by deletion rather than by decision.** Configuration is now read from environment variables and nothing else. There is no config file, so the format-versioning question that blocked this phase has no subject left. Three further decisions fall out of that one: §9's credential sealing is suspended, §2's append-only registry cannot exist, and `init` validates without writing anything. Each affected section carries its own note below: §2, §4, §9, §14.6, §15 Phase 0, and "Branches not yet walked".

**Amendment, 2026-07-26 — `manualUpdate` moves to Phase 0, because its debounce turns out to belong to Pluggy.** `init` now asks every configured connection to sync, unconditionally, and waits for it. The reason it can happen this early is that the "debounce measured in hours" of §11 needs no local state: `PATCH /items/{id}` answers **409 `CLIENT_IS_UPDATING_BEFORE_ALLOWED_FREQUENCY`** when the last sync is too recent, naming both the enforced interval and that sync's timestamp. Read the refusal as a successful *already fresh* and the whole feature needs no table, which is what unblocked it from Phase 5. Affected: §4, §11, §14.5, §14.6, §15 Phase 0 and Phase 5, §16.1, §16.2. `docs/research/pluggy-item-update.md` carries the sources and, more usefully, what the docs contradict themselves about.

---

## Context

`cata-centavo` is an MCP server that exposes Brazilian Open Finance data to an agent, reading from Pluggy via Connector 200 / MeuPluggy.

Talking directly to the Open Finance Brasil APIs requires membership in the BACEN Participant Directory: an ITP license, ICP-Brasil/OFB certificates, mTLS, FAPI, DCR per institution, and certification against the OpenID Foundation conformance suite. The barrier is regulatory, not technical. No open source alternative exists as a *data source* — only as a layer on top. Pluggy is therefore a premise, not a choice.

Product detail (tools, per-institution pitfalls, rate limits) lives in the main spec. This ADR records the engineering decisions.

---

## 1. Audience and distribution

**Decision:** a product for technically-minded friends, and a portfolio piece. Published publicly on npm, run via `npx cata-centavo`. The package name was verified as available on the registry.

**Alternatives rejected:**

| Alternative | Why not |
|---|---|
| Strictly personal use | Doesn't justify publishing; `npm i -g github:...` would do |
| Portfolio only (code to read, not run) | Throws away half the value; we want people using it |

**Accepted consequences:**

- The README is a first-class deliverable, not a footnote.
- Onboarding has to work for a third party, which requires `init` and `doctor` (§4).
- Publishing publicly means strangers' issues in the inbox.

---

## 2. Item discovery is impossible

**Verified fact** in `pluggy-sdk@0.90.0`: `Item` is the only resource in the SDK without a list operation.

```
fetchAccount / fetchAccounts        singular + plural
fetchInvestment / fetchInvestments  singular + plural
fetchConsent / fetchConsents        singular + plural
fetchCreditCardBill / ...Bills      singular + plural
fetchItem                           singular ONLY — fetchItems does not exist
```

This is not an oversight. It is a deliberate security decision by Pluggy, who ask integrators to track `itemId`s in their own datastore. A leaked API key cannot enumerate connections.

**What this does and does not mean.** The earlier version of this ADR concluded "the `itemId` necessarily comes from the user, pasted by hand, and there is no way to improve on this". That is too strong. Reviewing the prior Go implementation (§16) surfaced two mechanisms this document had missed:

**`POST /connect_token`.** Pluggy issues a short-lived token (30m) that opens the Pluggy Connect widget. Passing an existing `itemId` re-authenticates that connection — this is the supported recovery path when credentials expire or consent is revoked, and it means **re-linking never requires the user to find a UUID again**. Omitting the `itemId` creates a *new* item through the widget. The Go implementation always passes one, using it purely for re-auth.

**An append-only local registry.** Rather than a hand-maintained list, the server records every `itemId` the first time any tool resolves it successfully. Once seen, never lost. The prior implementation's own comment states the reasoning independently: *"The Pluggy API has no 'list all items' endpoint, so the server remembers each item_id the first time any tool resolves it successfully."* — corroborating §2's finding from a second direction.

> **Amendment, 2026-07-25 — the registry does not exist.** Under environment-only configuration there is no file of ours to append to, so nothing is remembered between runs. The set of connections is exactly what `PLUGGY_ITEM_IDS` says at process start. This is a real loss and not an implementation detail: the paragraph above was the reason onboarding could be described as "paste each id once, ever", and without the registry it is "keep each id in your environment". Bring the registry back the day a local file exists again, wherever that file lands.

**What remains genuinely impossible on our tier:** capturing the id of a *newly created* item back into a local process. The widget hands the new `itemId` to a callback, and callbacks mean webhooks, which the free tier does not include (see Context). So first contact with a bank still requires the user to read an id from the MeuPluggy dashboard and give it to us once. After that, the registry and connect tokens carry it.

**Consequence:** onboarding is "paste each id once, ever" — not "maintain a list of ids". The remaining job is to trade *silent failure* for *verified failure* at that one moment — see §4.

**Bonus findings that resolve pitfalls from the main spec:**

- `fetchConsents(itemId)` returns a `Consent` carrying explicit `expiresAt` and `revokedAt`. Revoked consent stops being guesswork: an empty response plus a revoked consent becomes an explicit tool error instead of "you had no transactions this month".
- `Item` exposes `status`, `executionStatus`, `statusDetail`, `lastUpdatedAt` and `consecutiveFailedLoginAttempts` — raw material for `doctor` and `listSources`.

---

## 3. Runtime and language

**Decision:** Node 24 (`.nvmrc` = `v24.15.0`), TypeScript executed via native type stripping. No build step in development, no `tsx`, no `ts-node`.

Verified on Node 24.15.0 with TypeScript 7.0.2:

| Scenario | Result |
|---|---|
| `node file.ts`, no flags | works |
| `import { x } from "./mod.ts"` | works |
| `node --test` on `.ts` files | works, including native `t.mock.timers` |
| `enum`, `constructor(private x)` | `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` |
| `const x: number = "string"` | **runs fine** — Node strips types, it does not check them |

That last row is the one that matters: **type checking is neither optional nor a runtime concern.** `tsc --noEmit` remains mandatory, in the role of a linter.

```jsonc
// tsconfig.json — the options carrying weight
{
  "module": "nodenext",
  "erasableSyntaxOnly": true,             // rejects enum / parameter properties at tsc time,
                                          // before they become a production crash
  "verbatimModuleSyntax": true,
  "allowImportingTsExtensions": true,     // source imports "./balance.ts"
  "rewriteRelativeImportExtensions": true // build emits "./balance.js"
}
```

The `allowImportingTsExtensions` + `rewriteRelativeImportExtensions` pair closes the loop: import `.ts` (what Node wants in dev), publish `.js` (what the package needs). Verified against the generated `dist`.

**Accepted consequence:** no `enum` and no parameter properties. See §13 — open.

---

## 4. A CLI that is also an MCP server

**Decision:** the binary is a CLI with subcommands; the MCP server is the default mode.

```
npx cata-centavo init      interactive: validates credentials, validates each itemId,
                           prints "✓ Nubank — last synced 3h ago", writes config
npx cata-centavo doctor    diagnostics: consent, item status, last sync
npx cata-centavo           no argument = MCP server over stdio
```

**Rationale:** an MCP server on stdio **cannot prompt interactively** — stdin/stdout are the JSON-RPC channel, and any `readline` there corrupts the protocol. So `init` cannot be a tool; it has to be a CLI mode.

Argument parsing via `node:util` `parseArgs`, no dependency.

**Accepted consequence:** an interactive flow, config file writing, and a versioned config format enter scope. None of this was in the original implementation plan — it becomes step 0 (`init`) and step 7 (`doctor`).

> **Amendment, 2026-07-25.** Only the last sentence survives. Configuration comes from `PLUGGY_CLIENT_ID`, `PLUGGY_CLIENT_SECRET` and `PLUGGY_ITEM_IDS` (comma-separated), so there is no interactive flow, no file to write and no format to version. `init` still exists and is still a CLI mode, for the reason this section gives: it validates each id against the API before a wrong one costs the user two weeks of empty statements.
>
> Environment *variables*, never a `.env` file. §16.2 records the prior implementation auto-loading `.env` from the current working directory, which under `npx` is wherever the user happened to be standing. We read `process.env` and stop there.
>
> The cost lands on server mode. `.zshrc` is read by interactive shells, and an MCP client that spawns our process hands it the client's own environment, so the variables have to be repeated in the client config's `env` block. That is the standard mechanism for MCP servers, but it is one more step in the README that a config file would not have needed.

**Rule that follows from stdio:** nothing but JSON-RPC may reach stdout. Logging goes to stderr, always. (The `node:sqlite` `ExperimentalWarning` on Node 22 goes to stderr — harmless — but on Node 24 it doesn't exist at all, since the module is stable.)

---

## 5. MCP SDK: stable v1

**Decision:** `@modelcontextprotocol/sdk@1.x`.

v2 (`2.0.0-beta.5`) split the package along exactly the architectural axis we wanted — `core` / `server` / `express` / `node` separated, transport as a boundary package:

| Package | Direct deps |
|---|---|
| `@modelcontextprotocol/sdk@1.29.0` | **17** — including `express@5`, `hono`, `cors`, `jose`, `pkce-challenge`, `ajv` |
| `@modelcontextprotocol/server@2.0.0-beta.5` | **2** — `zod@4` + `core` |
| `@modelcontextprotocol/core@2.0.0-beta.5` | **1** — `zod@4` |

On v1, a server that only speaks stdio still installs an entire web framework and an OAuth stack.

**We are picking v1 anyway.** The `registerTool` signature is nearly identical across both, which means v2's decoupling lives in the dependency graph and in runtime portability — **not in our code**.

The dependency cost is real and should not be waved away: the rest of this ADR treats dependency minimalism as a first-class value (§7, §9's rejection of `keytar`, §10's zero native dependencies, §4's `parseArgs`), and 17 direct deps including a web framework and an OAuth stack is genuine install weight and supply-chain surface for a package strangers run via `npx` on a cold cache. **The argument for v1 is not that this cost is trivial — it is that a beta API shifting underneath the project costs more, and that migrating later is cheap precisely because the application code is identical either way.** We are accepting a known, bounded weight to avoid an unbounded churn risk.

**Revisit when:** v2 leaves beta, or a need arises to run on an edge runtime (v2 ships a `./validators/cf-worker` export).

---

## 6. Directory layout

```
src/
├── core/          business rules. no fetch, no sqlite, no SDK
│   ├── account.ts · transaction.ts · balance.ts
│   ├── installments.ts · bill.ts · category.ts
│   └── contracts.ts    interfaces core requires of whoever serves it
├── pluggy/        client.ts · mapper.ts · errors.ts
├── storage/       db.ts · schema.sql · store.ts
├── mcp/           server.ts · format.ts · tools/
├── cli/           init.ts · doctor.ts
├── config.ts
└── bin/cata-centavo.ts
tests/
├── core/ · pluggy/ · storage/ · mcp/
├── fakes/         fake-bank.ts · fixed-clock.ts · fake-store.ts
└── fixtures/      raw JSON captured from Pluggy
```

**The rule holding this together:** `src/core/` imports nothing from `src/pluggy/`, `src/storage/` or `src/mcp/`. The interfaces live in `core/contracts.ts` because the contract belongs to the consumer, not the implementer.

Enforcing this mechanically costs a third devDependency — neither `tsc` nor `@types/node` can express an import-direction constraint. Options: `dependency-cruiser`, or ESLint with `import/no-restricted-paths`. **Until one is added, the rule is convention, not enforcement**, and §7's "entire devDependencies" holds. Decide at phase 1, when `core/` first has something worth protecting; a cheap interim is a CI grep for forbidden import paths, which needs no dependency at all.

**Explicit naming and layout decisions:**

- Directories are **not** named after architectural patterns (`ports/`, `adapters/`). The pattern lives in the direction of dependencies, not in a folder name.
- Names in English.
- Tests in `tests/`, mirroring `src/`. Not colocated. Useful side effect: the build tsconfig becomes `include: ["src"]`, with no extra file.
- `tests/fakes/` sitting outside `src/` makes it impossible for production code to import a fake.
- No `services/` and no `utils/` — the two directories that become junk drawers and eat the domain over time.

Verified: `node --test` finds `tests/**/*.test.ts` with no arguments.

---

## 7. Tests: native runner

**Decision:** `node --test` + `node:assert`. No Jest, no Vitest, no `ts-jest`.

The project's entire `devDependencies`: `typescript` and `@types/node`.

`t.mock.timers` covers the injectable `Clock` and the 7-day freshness rule without a fake-timer library.

---

## 8. Transport

**Decision (pending confirmation — see §13):** ship stdio only, keeping the boundary ready for HTTP.

The project runs locally, single user, credentials in a local config. Streamable HTTP delivers nothing in that shape while charging for sessions, CORS, Host/Origin validation and authentication.

To be precise about the cost of deferring, because the two halves are often conflated: **wiring `core` to an HTTP transport is trivial** — the SDK's transport is a mounted handler and the server object is unchanged, so that part really is a small file. **Making it safe is not**, and that is the part being deferred. Sessions, origin validation and auth are only optional while the listener is a single local user; the moment the server is reachable, §9's entire posture ("the local disk is trusted", plaintext credentials, no authentication) stops holding, because the threat model changes from "who can read my disk" to "who can reach my port". So adding HTTP is not a 30-line change — it is a 30-line change plus a re-litigation of §9.

Factual note: "Streamable HTTP" is the protocol's transport name (POST + SSE); it has nothing to do with Node streams. The SDK implements it end to end.

---

## 9. Security: the local disk is trusted

**Decision:** posture (A) — config and data in `0600` files, unencrypted. **Stated in the README**, not assumed by omission.

**Reasoning:** protecting the `clientSecret` while the cache sits in plaintext is theatre. What does the secret grant? Access to the full financial history. What is in the SQLite file? The full financial history, already downloaded. Anyone with read access to the home directory already has the prize, with no rate limit attached.

**Refinement after reviewing prior art (§16).** The Go implementation went further than posture (A): it seals credentials, the cached API key and connect tokens with AES-256-GCM in SQLite, resolving the master key as `$OPENFINANCE_DB_KEY` → OS keychain → `~/.openfinance/master.key` (0600). That is worth taking seriously, because the argument above ("encrypting the secret is theatre while the cache is plaintext") **only holds once a transaction cache exists** — and the Go version has none, it is a stateless passthrough. Its threat model is genuinely different from ours.

For us the split is: **sealing the credential is cheap and worth doing; sealing the cache is not feasible.** `node:crypto` does AES-256-GCM with no dependency at all, so encrypting the few secret *values* costs nothing and removes the "my clientSecret leaked in a backup" failure mode. Encrypting the transaction cache would need SQLCipher, which `node:sqlite` does not have.

**Decision:** seal credential values at rest with `node:crypto` AES-256-GCM, key from `$CATA_CENTAVO_KEY` → generated keyfile at `0600`. **Skip the OS keychain tier** — that is where the Go version needs a platform binding, and it is the one rung that would cost us a native dependency (§10). Cache stays plaintext, and the README says so.

> **Amendment, 2026-07-25 — sealing is suspended, and the failure mode it addressed is gone anyway.** Credentials live in the environment. We never write them to disk, so there is no `secret.ts`, no master key, no `0600` keyfile and no sealed KV table. The one benefit the paragraph above claimed for sealing was removing "my clientSecret leaked in a backup"; not writing the secret at all removes it more completely than encrypting it would.
>
> Two things do not change. The transaction cache is still plaintext and the README still has to say so, because that argument never depended on where the credential lived. And the `apiKey` is still a secret with a two-hour life: it is now cached in memory only, which is enough because the server process lives for the whole MCP session and `init` is a single short run.
>
> What this gives up is the ability to configure the server without touching the environment, which matters for GUI MCP clients (see §4's note). Revisit the whole of this section the day a config file or a local registry comes back, because the sealed KV is the right home for both the credential and the 30-minute connect tokens of §2.

**Rejected — OS keychain:** `keytar` is a native module, which contradicts §10 head-on and makes `npx` require a per-platform build matrix.

**Rejected — encrypting the `.db`:** breaks `node:sqlite` (no SQLCipher), reintroduces a native dependency, and demands a passphrase every time the MCP client starts the server.

**Accepted and documented consequence:** anyone who can read files as the user's uid — or as root — has their full financial history. `0600` does stop a second unprivileged local account, so the exposure is "whoever is the user" rather than "whoever is on the box". The files live under `XDG_CACHE_HOME` / `XDG_DATA_HOME` (§10), which are usually but not necessarily inside `$HOME`; the permission bits, not the location, are what carry the guarantee.

Note this posture is **not** justified by "the MCP client stores secrets in plaintext anyway". Under §4, `init` writes our own config and the client config need hold no credential at all. The justification is the one above — the cache holds the same data the secret protects, so encrypting one and not the other buys nothing.

---

## 10. Persistence: two SQLite files

**Decision:** `node:sqlite` from the runtime, **zero native dependencies**, split across two files.

| File | Location | Contents | Droppable? |
|---|---|---|---|
| `cache.db` | `XDG_CACHE_HOME` | accounts, transactions | **yes** — refetched from Pluggy |
| `data.db` | `XDG_DATA_HOME` | overrides, rules, closing days | **never** |

**Why split:** the original schema mixed disposable cache with irreplaceable manual work in a single file, in a directory whose name invites deletion. An `rm` to "force a refresh" would cost the user their categorization rules, with no backup and no warning.

`npx` runs from any directory, so nothing lives in the cwd. Paths resolved via XDG, with the equivalent convention on macOS.

Verified: `ATTACH DATABASE` works in `node:sqlite` and allows `JOIN`s across the two files. Splitting costs nothing in query ergonomics.

### Schema migration

`npx` always fetches the latest published version, so **we do not control when the user upgrades**. Migration stops being optional the moment a second user exists.

Verified: `PRAGMA user_version` works in `node:sqlite` — free versioning, no metadata table.

| | `cache.db` | `data.db` |
|---|---|---|
| Schema changed | `user_version` mismatch → **drop and rebuild** | a real versioned migration |
| Cost to the user | one re-sync | zero, if done right |
| Can we get it wrong? | yes, harmlessly | **no** |

The split **did not eliminate** the migration problem. It reduced the surface needing migration from "the whole schema" to three small tables. That is a large win, but it is not the same as "no longer a problem".

---

## 11. No sync of our own

Pluggy syncs with the banks daily on its own, and batch processes against the API are explicitly prohibited. **Do not build a cron.** The cache is populated on demand, at read time.

`manualUpdate` (`PATCH /items/{id}` + poll) exists for user-triggered refreshes, with a debounce measured in hours — it returns "updated X minutes ago" rather than firing again.

> **Amendment, 2026-07-26 — the debounce is Pluggy's, not ours.** Every sentence above survives; only the ownership of the last one changes. Pluggy enforces a minimum interval between client-triggered updates and refuses a `PATCH` that comes too soon with a 409 carrying `minUpdateFrequencyAllowedInHours` and the last `lastUpdatedAt`. So `init` asks unconditionally and treats that refusal as the answer, rather than keeping a timestamp of its own — which it could not do anyway, since §2's amendment leaves nothing remembered between runs.
>
> Brand-new client IDs are capped harder still, at one API update per hour, so most runs land on the refusal path. Auto-sync, meanwhile, runs every 24, 12 or 8 hours by subscription tier and on production applications only.
>
> **"Do not build a cron" is untouched, and it now has teeth.** This fires when a human types `init`, never on a schedule. Pluggy's prohibition on batch update processes is explicit.
>
> One finding worth carrying into Phase 4: for Open Finance connectors, an update does not refresh every product. Balances and recent transactions move on every update; **credit card bills, investment lists and loan instalments move once per day regardless.** Running `init` twice in an hour buys fresher balances and nothing else.

---

## 12. Categorization

**Decision in one sentence:** a transaction's category is **not stored**. It is derived at read time, inside a single SQL query, from three independent lookups in V1 — override, counterparty, MCC — and from those plus a specificity-ranked rule engine in V2. The server never calls an LLM.

### 12.1 Why this is our problem

Pluggy's free tier (Connector 200 / MeuPluggy) excludes the enrichment block. Verified against `pluggy-sdk@0.90.0`:

| Field | On the free tier |
|---|---|
| `transaction.category` / `categoryId` | comes back `null` — useless |
| `transaction.merchant.cnpj` | `merchant?` is enrichment, comes back `undefined` |
| `transaction.description` | always present, dirty and unstable text |
| `transaction.descriptionRaw` | `string \| null`, raw text from the institution |
| `transaction.creditCardMetadata.payeeMCC` | present on cards — supplied by the card network |
| `transaction.paymentData.receiver.documentNumber` | present on PIX/TED/boleto — `{type: 'CPF'\|'CNPJ', value}` |

The asymmetry that drives the design:

```
Card purchase      → has MCC, NO paymentData, NO merchant.cnpj
                     ⇒ only description + MCC remain

PIX / TED / boleto → has the counterparty's documentNumber (a stable CNPJ)
                     ⇒ reliable match by document
```

Matching by CNPJ is ideal and only exists off-card. On cards we are forced to match on text. The field that would solve it (`merchant.cnpj`) is exactly what Pluggy charges for. Caveat: `paymentData` has known holes (batch operations, deposits under R$ 2,000, fees, charges, withdrawals, yields, redemptions), so even off-card the document is not guaranteed.

### 12.2 Model and scope split

| Source | Scope | Where it lives | Release |
|---|---|---|---|
| **Override** | one specific transaction | `data.db.category_overrides` | **V1** |
| **Counterparty** | every transaction with that CPF/CNPJ, retroactive | `data.db.counterparty_categories` | **V1** |
| **Default MCC** | fallback by industry | `cache.db.mcc_categories`, seeded from an ISO 18245 map in the code | **V1** |
| **Rule** | everything matching a criterion conjunction, retroactive | `data.db.category_rules` | V2 |

**V1 precedence is fixed and needs no engine:** `override > counterparty > MCC > none`. Three independent lookups, resolved by a `COALESCE`. Specificity ranking only exists in V2, where rules can combine criteria and therefore genuinely compete.

**Why counterparty is in V1 and not deferred with rules.** §12.1's asymmetry cuts the wallet in half: MCC exists only on cards, and the counterparty document exists only *off* cards. Shipping V1 with MCC alone would mean **zero automatic categorization for every PIX, TED, boleto and checking-account transaction** — in Brazil, that is most of the spending for most people. It would also make Phase 3's stated measurement ("what fraction MCC alone covers") structurally meaningless, since the answer is 0% for half the data. A document lookup is a single-column equality join; it needs none of the V2 engine, and it is what makes V1's coverage honest.

**`document` needs an explicit absent representation before it can be a join key.** §12.1 already notes `paymentData` has holes. §16 found the sharper form of the problem: in the prior implementation `documentNumber` is a value type, so a missing counterparty deserializes to `{type: "", value: ""}` and the response layer then strips the empty string entirely. If we let "absent" collapse to `""`, the counterparty subselect joins every document-less transaction to every other one and mass-mislabels them. `transactions.document` must be `NULL` when absent — never `''` — and `setCounterpartyCategory` must reject an empty document.

**Why the MCC map is a table and not a constant in code.** `getTransactions` accepts a `categories` filter (§14.2), and that filter runs in SQL. A map living in JavaScript cannot participate in the query, so filtering would silently return only overridden rows and omit every MCC-derived one. The map is therefore seeded into `cache.db.mcc_categories` by the migration that creates it — static reference data, rebuilt from code on every cache drop, never user-editable.

An override always beats a rule. Among rules, the **most specific** wins — measured by how many non-null criteria it uses. Ties break on `created_at DESC`, so the most recent correction wins.

There is no hardcoded precedence ladder (`document > description > MCC`). **Criterion counting does not reproduce such a ladder, and does not try to.** Two single-criterion rules — `{document: X} → market` and `{mcc: 5814} → restaurant` — both score 1 against a PIX transaction carrying both, so the winner is whichever was written last. A ladder would say document always wins. The two schemes agree only when the criterion counts differ. We accept the recency tiebreak as *deterministic rather than correct* (§12.7) instead of encoding a ladder, because a ladder asserts a global truth about criterion quality that our data does not support: `document` is stronger than `mcc` for a known CNPJ, and useless for the batch operations where `paymentData` is empty (§12.1).

Rules carry three nullable criteria evaluated with `AND`. The concrete motivator: `DEIVYN LANCHES` (delivery) and `DEIVYN PNEUS` (tyre shop) coexist. Matching on description alone cannot tell them apart; description **and** MCC can.

### 12.3 Deriving instead of storing

Measured with a synthetic 20,000 transactions × 60 rules, no index, scanned in one pass: **~150ms**. This benchmark is **V2-shaped** — it exercises the rules subselect, which V1 does not have. For V1 (a single override subselect) the cost is strictly lower, so the benchmark bounds V1 without describing it.

Two honest caveats: 20,000 rows is roughly 1,600/month for a year, not the ~500/month a lighter user sees, so treat it as the heavier end rather than a typical case; and it is **one measurement at one rule count, not a worst case** — V2 caps neither rule count nor query range. If either grows, re-measure before assuming the headroom survived.

The decision does not rest on the number anyway. Materializing a `category` column would force invalidation and recompute on every rule change, turning a bad rule into broad, irreversible damage; deleting a rule instead makes the next read correct with no recompute. That argument is about reversibility, and it holds at any latency we are plausibly going to see. (Note it is also a **V2 argument** — in V1, with only overrides, there is no rule to change and nothing to invalidate. V1 derives at read time to avoid a schema that V2 would have to undo, not to solve a problem V1 has.)

The **V1** query — three lookups, no ranking:

```sql
SELECT t.id, t.description_norm,
  COALESCE(
    (SELECT o.category FROM userdata.category_overrides o WHERE o.transaction_id = t.id),
    (SELECT c.category FROM userdata.counterparty_categories c WHERE c.document = t.document),
    (SELECT m.category FROM mcc_categories m WHERE m.mcc = t.mcc)
  ) AS category
FROM transactions t
WHERE t.date BETWEEN :from AND :to
```

The **V2** query adds the rule subselect between counterparty and MCC, and only there does specificity ranking appear:

```sql
SELECT t.id, t.description_norm,
  COALESCE(
    (SELECT o.category FROM userdata.category_overrides o
      WHERE o.transaction_id = t.id),
    (SELECT c.category FROM userdata.counterparty_categories c
      WHERE c.document = t.document),
    (SELECT r.category FROM userdata.category_rules r
      WHERE (r.description_contains IS NULL OR instr(t.description_norm, r.description_contains) > 0)
        AND (r.mcc      IS NULL OR r.mcc      = t.mcc)
        AND (r.document IS NULL OR r.document = t.document)
      ORDER BY (r.description_contains IS NOT NULL)
             + (r.mcc                  IS NOT NULL)
             + (r.document             IS NOT NULL) DESC,
               r.created_at DESC
      LIMIT 1)
  ) AS category
FROM transactions t
WHERE t.date BETWEEN :from AND :to
```

Verified behaviour of the ranked V2 form: `DEIVYN LANCHES`/5814 → delivery and `DEIVYN PNEUS`/5532 → car, both via two-criteria rules; `RESTAURANTE XY`/5814 → restaurant via an MCC-only rule; `TRANSF PIX` → market via a document rule; an unmatched row falls through to `null`.

`category_src` is not a column, but tool responses must expose it as a computed value so the agent can explain its reasoning. V1 emits `"override"`, `"counterparty"`, `"mcc"` or `"none"`; V2 adds `"rule:12"`.

### 12.4 Taxonomy is the blocking decision

**The MCC table has to be populated before anything works** — seeing MCC `5814` and returning a category presupposes that a target category exists. That makes taxonomy the *first* implementation decision, not a finishing detail.

Order matters: the ~1000 ISO 18245 codes cannot be mapped before the category list is fixed. Does `5814` become `alimentacao`, `restaurante` or `delivery`? The answer changes the entire mapping.

To do at implementation time:

1. Define **N predefined categories** as a closed, validated list. Free-form strings are rejected — they let the agent invent `alimentacao` and `alimentação` in the same database and break every aggregation.
2. **Research Pierre's taxonomy** (`docs.pierre.finance`) and Brazilian personal-finance apps, and copy one already validated in production. Personal-finance taxonomy is a solved problem, and Pierre is the reference this project already mirrors for tool design.
3. Only then map MCC → category, covering the codes that actually show up in real statements. All 1000 are not needed up front.

The category becomes a union type / `z.enum` in `core/category.ts`, and tool validation rejects anything outside the list.

### 12.5 Description normalization

A **pure** function living in `core/`, applied in two places: when writing `transactions.description_norm`, and when writing a rule's `description_contains`.

```
"PAG*DEIVYN LANCHES LTDA 03/12"
  → uppercase → strip accents → strip acquirer prefixes (PAG*, PG *, CIELO*, REDE*, ...)
  → strip trailing date/sequence → collapse whitespace
  = "DEIVYN LANCHES"
```

This is the highest-value unit test in the project; feed it real cases as they appear, and expect the prefix list to grow with experience rather than be right the first time. Matching is case-insensitive substring against the normalized form — exact match is useless, since the same merchant shows up as `DEIVYN LANCHES`, `PAG*DEIVYN` and `DEIVYN LANCHES LTDA 03/12`.

Normalization ships in V1 even without rules. Not because overrides need it — `setCategory` is keyed purely on transaction id and never reads `description_norm` — but because **retrofitting it later means rewriting every cached row**, and because grouping by normalized description is what lets the agent (and `getTransactions`' aggregates) present "you spent at Deivyn 7 times" instead of seven unrelated strings. The V2 discoverability resource in §12.8 depends on it too.

Regex matching is **out of V1**: it arrives as user input, needs validation, risks ReDoS stalling the server, and is more power than the real cases need. Adding it later needs no migration — a `match_mode` column defaulting to `'contains'` would cover it.

### 12.6 Tools

These are the project's first **write** tools.

**V1** — `setCategory(transactionIds: string[], category: string)` writes an override, beats everything, and validates `category` against the closed list.

**V1** — `setCounterpartyCategory(document: string, category: string)` maps a CPF/CNPJ to a category, retroactively and going forward. Digits only, punctuation stripped on write. Returns how many existing transactions it now covers, for the same reason `addRule` does. This is the non-card half of V1 coverage (§12.2).

**V2** — `addRule({ descriptionContains?, mcc?, document?, category })` (at least one criterion required, returns how many transactions it now affects plus a 5-row sample), `listRules()` (rules with affected counts), `deleteRule(id)`.

The agent is allowed to create rules on its own. That is safe because nothing is destroyed: categories are derived, so a bad rule is one `DELETE` away from being undone and the next read is already correct. The count-plus-sample return value is the safeguard — "this affects 3,400 transactions" tells both model and user the rule is too broad before they commit to it.

### 12.7 Ambiguity (V2)

Two rules of equal specificity can match the same transaction and disagree. The `created_at DESC` tiebreak makes that **deterministic, not correct**. `doctor` should detect and report rules of equal specificity whose matched sets overlap with conflicting categories.

Known residual risk: a generic rule (`DEIVYN`, no MCC) living alongside the specific ones captures any Deivyn with an unknown MCC, tyre shop included. With both present, simply do not create the generic rule — the engine cannot infer what was never declared.

### 12.8 V2: how the agent learns it can offer rules

The central V2 feature is not technical, it is **discoverability**. A user who has corrected the same merchant five times does not know rules exist, and the agent will not offer them unless something says it can.

The only discovery surface an MCP client gives a model is the **description** of tools, resources and prompts. So the affordance has to be designed there, explicitly. To settle during V2 implementation:

- `setCategory`'s description should mention that repeated overrides suggest a rule, and point at `addRule` — so the model sees the path at the moment the pattern appears.
- Consider exposing a **resource** listing recent overrides grouped by normalized description, letting the agent spot the pattern without asking.
- Consider a **prompt** ("review my categorizations") as an explicit user-initiated entry point.
- `addRule` already returns count plus sample, which gives the agent concrete material for the suggestion ("this would cover 47 transactions, including…").

### 12.9 What V1 gives up

**Rules over description text, and criterion conjunction.** The specificity engine, `category_rules`, and the three rule tools move to V2.

What V1 keeps is the retroactive path that costs nothing: `setCounterpartyCategory` covers every past and future transaction with a given CPF/CNPJ, and MCC covers cards by industry. **So "correct 300 supermarket entries one by one" is not the V1 experience** — one `setCounterpartyCategory` call handles a merchant that pays by PIX or boleto, and MCC handles it on card. What V1 genuinely cannot do is categorize by *description text*, which is the only signal left when a card purchase has an unhelpful MCC and no document. That is the gap V2 closes, and the size of it is exactly what phase 3 measures.

Introducing `category_rules` in V2 is a `CREATE TABLE` at a new `user_version` and touches no existing data, so this scope cut creates no migration debt.

**Automatic LLM categorization.** The original plan was `rule → override → MCC → LLM in batch`. Cut. Accepted consequence: **nobody opens Claude and finds everything already categorized** — someone has to ask. The agent reads the uncategorized rows, decides, and persists via `setCategory`. Revisit only after measuring, on real data, how much MCC alone already covers.

### 12.10 Alternatives rejected

| Alternative | Why not |
|---|---|
| Materialize `category` on `transactions` | Forces invalidation and recompute on every rule change; a bad rule becomes broad, irreversible damage. Deriving costs ~150ms worst case |
| Keep overrides in `cache.db.transactions` | Irreplaceable data in a disposable table. The first cache drop erases manual work |
| A single `match_type` per rule | Cannot express "description AND MCC", which is the Deivyn case |
| Hardcoded ladder `document > description > MCC` | Asserts a global ranking of criterion quality that the data does not support — `document` is the strongest signal when present and absent entirely on cards and batch operations (§12.1). Criterion counting does **not** reproduce this ordering (§12.2); we are choosing recency over a ladder, not claiming equivalence |
| Regex in V1 | ReDoS, validation burden, complexity. Deferrable at no migration cost |
| Free-form category strings | The agent invents `alimentacao` and `alimentação` in one database; aggregation breaks |
| LLM with our own API key in the server | Requires an Anthropic key on top of Pluggy, adds a dependency and a per-token cost |
| LLM via MCP sampling (`createMessage`) | Elegant — no key — but sampling is **optional** in the MCP spec and client support is uncertain. Revisit |

### 12.11 Tests this implies

Pure, no I/O, in `tests/core/`: description normalization against accumulated real cases (V1); default MCC maps to a valid taxonomy category (V1); a category outside the closed list is rejected (V1); two criteria beat one, an override beats any rule, equal specificity resolves to the most recent, and a rule with no criteria is rejected (all V2).

With SQLite `:memory:` in `tests/storage/`: the canonical query with two `ATTACH`ed files (V1, reduced form); an override survives dropping `cache.db` (V1); the full Deivyn case (V2); `deleteRule` reverts with no recompute (V2); a rule created today affects a transaction from last year (V2).

### 12.12 Open points

1. **Which N categories.** Blocks V1. Research Pierre and Brazilian apps before deciding (§12.4).
2. **Which MCCs to map**, and to what. Entirely dependent on (1).
3. Should `descriptionRaw` feed normalization when `description` is poor? Only decidable against real data.
4. `doctor` detecting ambiguity: presumably alongside V2.

---

## 13. Open items in this ADR

1. **§8 — transport.** stdio-only was recommended, not confirmed. If the answer turns out to be "both from the start", §6 gains `bin/http.ts` and scope grows.
2. **§3 — `enum`.** A `const` object plus derived union was recommended, because it pairs with Zod at the Pluggy boundary (a TS string enum is nominal: `"BANK"` arriving as JSON cannot be assigned without a cast, precisely where we wanted validation). Not confirmed. If real `enum`s win, `erasableSyntaxOnly` comes out and `--experimental-transform-types` goes into the dev scripts — the published package is compiled by `tsc`, so production uses no flag either way.

---

## 14. Complete tool inventory

Seventeen MCP tools plus three CLI commands. Fourteen tools ship in V1; three are V2.

### 14.0 Naming and description conventions

Two conventions, both taken from the prior Go implementation (§16), which got them right:

**Speak the user's domain, not Pluggy's.** Pluggy calls a bank link an *item*; no human does. Tools take `connectionId`, never `itemId`, and the mapping to Pluggy's vocabulary stays inside `pluggy/mapper.ts`. The model reasons better about "connection to Nubank" than about an opaque item, and the user reads tool calls in their transcript.

**Every tool description follows the same three-part template**, because tool descriptions are the *only* discovery surface a model gets — the same fact §12.8 leans on for V2 rules:

```
<one line: what it does>

Use this tool when:
- <situation>
- <situation>

Returns: <what comes back, in domain terms>
```

The "Use this tool when" block is what stops a model from reaching for `listTransactions` when it wanted `getTransactions` aggregates. Write it for every tool, including the trivial ones.

**Open naming question, unresolved.** The Go implementation uses `snake_case` (`list_accounts`, `get_current_bill`); this document has used `camelCase` throughout, following [Pierre's MCP API](https://docs.pierre.finance/api-reference/mcp/introduction), which is the reference this project otherwise tracks. Pick one before phase 1 and apply it uniformly — the inventory below is written in camelCase and would need a mechanical pass if snake_case wins.

### 14.1 Read tools — accounts and balances

**`getAccounts()`** — V1 · effort: medium
Fans out over the configured `itemId`s and merges three endpoints (`GET /accounts`, `/investments`, `/loans`) into one shape. Returns, per account: id, institution, human-readable name, `type`, `subtype`, balance, and for cards `creditLimit`, `availableCreditLimit`, `balanceCloseDate`, `balanceDueDate`, `brand`. This is the map everything else resolves against.

**`type` cannot be Pluggy's `BANK | CREDIT` union**, because investments and loans are representable under neither. Our `type` is a superset — `BANK | CREDIT | INVESTMENT | LOAN` — and `subtype` (`CHECKING_ACCOUNT` | `SAVINGS_ACCOUNT` | `CREDIT_CARD` | …) is only meaningful for the first two. This is our type, not Pluggy's; the mapper in `pluggy/mapper.ts` owns the widening.

**`getBalance()`** — V1 · effort: trivial
Consolidated balance across accounts. **Must filter to `type === "BANK"`.** On a checking account `balance` is available money; on `CREDIT` it is the open unpaid bill — and on regulated Open Finance connectors, the used limit. Summing the two produces a meaningless number. This is pitfall #1 and it is the single easiest way to ship a tool that lies confidently.

Excluding `LOAN` follows the same logic (a debt is not money you have). Excluding `INVESTMENT` is **not** obviously right — for most people invested balance is net worth — but investments and cash are not fungible on a given day, so a single summed number would mislead in the other direction. **Decision: `getBalance` returns cash only, and reports invested and owed totals as separate labelled figures rather than folding them in.** Revisit if it proves annoying in practice.

**`getBalanceByAccount(accountId)`** — V1 · effort: trivial
`GET /accounts/{id}`. Direct passthrough with our field mapping.

### 14.2 Read tools — transactions

**`getTransactions({ startDate, endDate, categories?, minAmount?, maxAmount?, accountType?, accountSubtype? })`** — V1 · effort: medium
The core of the project. Pluggy's endpoint **requires `accountId`** — it does not accept an `itemId`, and it filters by neither category nor amount. So the flow is: resolve accounts → paginate each one → merge → filter locally. Category filtering works in V1 despite categories being derived, because the derivation happens in the same SQL query (§12.3).

**Pagination has no prior art and must be built from scratch.** §16 found that the prior implementation never paginates *anything*: it decodes `totalPages` and never reads it, forwarding a single page and leaving the model to ask for more. Two endpoints send no pagination parameters at all and therefore silently receive Pluggy's default of 20 rows. The concrete rule for us:

- `pageSize = 500` (the documented maximum) on every paginated endpoint — `/transactions`, `/accounts`, `/bills`, `/investments`.
- Loop until `page >= totalPages`. **Terminate on the reported total, not on a short page**, and assert the invariant so a Pluggy change surfaces as an error rather than as missing money.
- **Never expose Pluggy's pagination envelope to the model.** The prior implementation applies local filters, rewrites `total`, leaves `totalPages` stale, and hands the model `{total: 4, totalPages: 3}` — a self-contradictory object that something is expected to reason about. Our tools return our shape (§14.0); paging that the model drives is `listTransactions`' explicit cursor, nothing else.

This is the highest-cost silent failure available to this project: nothing errors, aggregates are simply computed over a fraction of the data.

**Deliberate divergence from Pierre:** Pierre offers `format: 'raw' | 'structured'`. We do not copy that. A model handed the choice picks `raw` and blows its own context. This tool returns **aggregates by default**, and detail is reached through explicitly bounded paths.

Each aggregate group carries **`sampleIds`, capped at 10**, alongside `label`, `total` and `count`:

```jsonc
{ "label": "Mercado", "total": -4200.00, "count": 37, "sampleIds": ["...", "..."] }
```

An earlier draft of this ADR said "always returns aggregates" with no ids at all. That was **circular and unimplementable**: `getTransactionDetails(ids)` and `setCategory(transactionIds)` both require ids, and no V1 tool emitted any. The agent literally could not reach the write path. Capping the sample is what actually protects the context window; withholding ids entirely protected nothing and broke the product.

**`listTransactions({ ...same filters, limit, cursor })`** — V1 · effort: low
Explicit paging when the agent needs the full set rather than a sample — bulk categorization being the motivating case. **Hard cap `limit <= 100`**, cursor-based. Returns rows with `id`, `date`, `description_norm`, `amount`, `category`, `category_src`.

The rule is therefore "**aggregated by default, explicit paging with a hard ceiling**", not "aggregated only". The ceiling is the safeguard; the aggregate default is the nudge.

**`getTransactionDetails(ids: string[])`** — V1 · effort: low
Full rows, including `paymentData` and card metadata, for an explicit, bounded set of ids. Distinct from `listTransactions` in that it takes ids the agent already chose rather than a filter.

**`getInstallments()`** — V1 · effort: **high** · implement last
There is no "installment purchase" entity in Pluggy. It is reconstructed from card metadata: `installmentNumber`, `totalInstallments`, `totalAmount` (the sum of all installments), `payeeMCC`, `cardNumber`, `billId`. Group by `description|totalAmount|totalInstallments`, take the max `installmentNumber` as paid, and derive what remains.

Behaviour varies by institution: some post every installment right after the purchase, others one per bill. Do not generalize from a single bank. This is why it is last on the roadmap — it needs real data from *your* banks in hand.

### 14.3 Read tools — credit cards

**`getBills(accountId)`** — V1 · effort: low
`GET /bills?accountId=`. Closed bills: `dueDate`, `billClosingDate`, `totalAmount`, `minimumPaymentAmount`, `financeCharges`, `payments`. **An empty list is a legitimate normal case, not an error** — bills are mandatory only under regulated Open Finance; on Direct connections only Inter PF and Itaú Cartões supply them.

**`getBillSummary(accountId)`** — V1 · effort: medium
The current, still-open bill. Combines `account.creditData` with the transactions belonging to the open bill. Returns closing date (with the local override as fallback), due date, partial total, credit limit, available limit and usage ratio.

**Which signal identifies an open-bill transaction is unresolved.** This ADR previously asserted that the `PENDING` / `POSTED` split partitions open from closed and "comes free from the API". The prior implementation (§16) — written against real data — does not use `status` at all. `Transaction.Status` is modelled in its entities and **never read anywhere in the codebase**; open-bill detection is `creditCardMetadata.billId == ""`. Two signals, one asserted and one battle-tested, and they may or may not agree. **Resolve in Phase 0.5.** Getting this wrong makes `getBillSummary` silently wrong about the number the user cares most about.

Two further constraints inherited from §16's analysis of the prior implementation:

- **Do not exclude transactions that lack `creditCardMetadata`.** The prior version skips them, which drops card payments, annuity fees, interest and IOF from the itemization while leaving them inside `account.balance` — so its headline figure and its line items are computed over different populations.
- **Guard the installment deduction against banks that post all installments upfront.** Deducting `amount × (totalInstallments − installmentNumber)` per row assumes one row per bill. On a bank that posts all ten rows of a 10× purchase at once, that deducts 45× the installment instead of 9×. §14.2 already records that posting behaviour varies by institution; this is where it does damage.

**`manageClosingDate({ operation, accountId?, day? })`** — V1 · effort: low
Purely local CRUD over `data.db.card_closing_day`, with `LIST`, `GET`, `INSERT`, `UPDATE`, `DELETE`. It exists because `balanceCloseDate` is not populated on every connector (pitfall #6), and `getBillSummary` needs a fallback.

**Open design question:** a single tool with an `operation` enum is harder for a model to use correctly than distinct verbs (`listClosingDates`, `setClosingDate`, `deleteClosingDate`). Pierre models it as one tool; we should probably not. Settle before implementing §15 phase 4.

### 14.4 Write tools — categorization

**`setCategory(transactionIds: string[], category: string)`** — V1 · effort: low
Writes an override into `data.db`. Beats any rule. `category` is validated against the closed taxonomy (§12.4). See §12.6.

**`addRule({ descriptionContains?, mcc?, document?, category })`** — V2
**`listRules()`** — V2
**`deleteRule(id)`** — V2
Specified in §12.6. The agent may create rules unaided because nothing is destroyed and a bad rule is one `DELETE` from undone.

### 14.5 Operations and observability

**`manualUpdate(connectionId)`** — V1 · effort: low
`PATCH /items/{id}`, then poll `GET /items/{id}` until `executionStatus` reaches `SUCCESS` or `PARTIAL_SUCCESS`. Rate limited to 20/min, and documented as being for *user-triggered* refreshes — daily updating is the auto-sync's job (§11). **Debounce measured in hours**, returning "updated X minutes ago" rather than firing again.

> **Amendment, 2026-07-26 — built, in `core/refresh.ts`, and reached first through `init` rather than as a tool.** The signature above said `itemId`, against §14.0's own rule; it is `connectionId` now.
>
> Three corrections the implementation forced:
>
> - **The loop condition is `status === "UPDATING"`, not an `executionStatus` allowlist.** That is what Pluggy's own polling recipe does, and it is the safer shape: everything else terminates, so a status neither we nor the docs have seen ends the loop and gets reported instead of spinning for nineteen minutes. Pluggy's OpenAPI schema declares both fields bare `string` with no enum, and its prose docs and its SDK disagree about the members, down to the spelling of the investments one. Closing either union would have been a mistake.
> - **20/min needs its own window.** The general limit is 360/min, so one shared limiter lets a fan-out of reads spend a budget the updates need. `transport` now claims a second window for `PATCH /items/`, in the same choke point and for the same §16.2 reason.
> - **`WAITING_USER_INPUT` is a first-class outcome, not an error.** The item carries the label of what the bank wants — "Chave de segurança" — and reporting that label is the difference between an actionable message and a shrug. Answering it (`POST /items/{id}/mfa`) is deliberately not built: `init` is non-interactive per §14.6, and a `LOGIN_ERROR` cannot be fixed from the API at all, only through Pluggy Connect.

**`listSources()`** — V1 · effort: trivial · not in Pierre
Returns the configured `itemId`s with institution, last sync, item `status` / `executionStatus`, and consent state. Given §2, this is the closest thing to an item listing that can exist.

It **mitigates pitfall #7** (revoked consent returns empty data, not an error) outright, via `fetchConsents`. It **does not mitigate pitfall #8** — a bank connected in MeuPluggy whose UUID never reached the config is, by §2, unobservable: the tool enumerates the config, and an item absent from the config is definitionally invisible to it. What `listSources` provides against #8 is only the raw material for the user to notice a gap themselves, by comparing the listed sources against the banks they know they linked. **Pitfall #8 is unmitigable in software under §2** and belongs in the README as an operational warning, not in a tool's justification.

### 14.6 CLI commands (not MCP tools)

**`init`** — interactive. Collects `clientId` / `clientSecret`, accepts `itemId`s one at a time, calls `fetchItem` on each to validate immediately, and writes the config. Turns a pasted-UUID mistake into a two-second error instead of two weeks of empty statements. Cannot be a tool, because stdio is the JSON-RPC channel (§4).

> **Amendment, 2026-07-25 — `init` validates, it does not collect and it does not write.** It reads the environment, authenticates once, calls the item endpoint on every configured id and prints a per-id report to stderr. Everything the original sentence promised about catching a pasted UUID still holds; only the writing is gone.
>
> One id failing does not abort the others. A report covering every connection is worth more than a report that stops at the first bad line, and the exit code carries the failure instead.
>
> This costs `init` its reason to be a CLI mode rather than a tool, since nothing interactive is left. It stays a CLI mode regardless, because a tool cannot be reached before the credentials it is diagnosing are known to work.

> **Amendment, 2026-07-26 — `init` still does not write locally, but it does write to Pluggy.** It asks every configured connection to sync (§14.5) and waits for the result. "It does not write" was about our disk and stays true; a `PATCH` is nonetheless a side effect that spends Open Finance product quota and sits under a 20/min ceiling, so the earlier sentence was too broad and this replaces it.
>
> The read still comes before the update, for two reasons that are both worth the extra request: a 404 catches a mis-pasted UUID before anything is spent, and the institution's name has to be on screen before a wait that can run for minutes, or the spinner shows a UUID the whole time.
>
> **Five outcomes replace pass/fail,** because "unusable" was hiding differences a user has to act on differently: *refreshed*, *already fresh* (the 409 of §11), *waiting on you* (MFA, naming the parameter), *login refused* (Pluggy Connect only), and *still syncing* (we ran out of patience; Pluggy has not). Only the first two count as usable and exit 0.
>
> **A `PARTIAL_SUCCESS` exits 0 and prints its warnings.** A product that hit its monthly Open Finance quota went unrefreshed, which means the numbers under it are older than the rest — worth a `!` and a line naming the product, and not worth failing over.
>
> Waiting silently for minutes is not acceptable, so `init` draws a live region on stderr: a spinner and the current stage per connection on a terminal, one plain line per stage change anywhere else. Stdout stays empty either way (§4).

**`doctor`** — diagnostics over every configured item: `status`, `executionStatus`, `statusDetail`, `lastUpdatedAt`, `consecutiveFailedLoginAttempts`, consent `expiresAt` / `revokedAt`, plus cache freshness and schema versions. In V2 it also reports rule ambiguity (§12.7).

**(default, no argument)** — the MCP server over stdio.

### 14.7 Summary

| Tool | Release | Source | Effort |
|---|---|---|---|
| `getAccounts` | V1 | `/accounts` + `/investments` + `/loans` per item | medium |
| `getBalance` | V1 | derived from `/accounts` | trivial |
| `getBalanceByAccount` | V1 | `GET /accounts/{id}` | trivial |
| `getTransactions` | V1 | `GET /transactions` + local filtering | medium |
| `listTransactions` | V1 | cache, paged, `limit <= 100` | low |
| `getTransactionDetails` | V1 | cache | low |
| `getBills` | V1 | `GET /bills?accountId=` | low |
| `getBillSummary` | V1 | derived — `creditData` + open-bill rows (signal TBD, §14.3) | medium |
| `getInstallments` | V1 | derived — no endpoint exists | **high** |
| `manageClosingDate` | V1 | local state only | low |
| `setCategory` | V1 | local state only | low |
| `setCounterpartyCategory` | V1 | local state only | low |
| `manualUpdate` | V1 | `PATCH /items/{id}` + poll | low |
| `listSources` | V1 | local + item/consent status | trivial |
| `addRule` | V2 | local state only | medium |
| `listRules` | V2 | local state only | low |
| `deleteRule` | V2 | local state only | trivial |

---

## 15. Implementation roadmap

Each phase is shippable and answers a question the next phase depends on. Phases 0 and 7 did not exist in the original plan; they are the cost of §1 (a real audience) and §4 (a CLI).

### Phase 0 — Foundations and onboarding

Config format and its versioning, XDG path resolution, `parseArgs` dispatch, both SQLite files with `PRAGMA user_version` and the migration runner, and `init` end to end.

**Auth discipline**, which §16 shows is where the prior implementation breaks in practice. It resolves the 2h `apiKey` once in the client constructor and freezes it on a struct field — no refresh, no expiry check, no 401 retry path. An MCP client keeps the server process alive for a whole session, so after two hours every tool returns an opaque status-code error. Our rules:

- Cache the key with a real **margin** (expire locally around 1h50m), not at Pluggy's full lifetime.
- Resolve it **lazily per request**, not once at startup — and never per request in the sense of re-authenticating; the cache is what prevents that.
- Guard the refresh with a **single-flight**, or the account fan-out issues N concurrent `POST /auth` calls.
- One forced refresh and retry on a 401, then fail loudly.

*Delivers:* a user can install and configure. *Answers:* are the credentials and item IDs even valid.

> **Amendment, 2026-07-25.** Config format and its versioning leave this phase (see §4). What remains is XDG path resolution, `parseArgs` dispatch, the two SQLite files with their migration runner, `init`, and the auth discipline above. Both migration chains start empty, because no table this project has decided on belongs to a phase this early; the runner ships anyway so Phase 1 costs one array entry instead of a design.
>
> **The premise of the auth paragraph does not transfer to the Node SDK.** "Resolves it once in the constructor and freezes it" is true of the Go implementation and false of `pluggy-sdk@0.90.0`, whose `baseApi.js` resolves the key at the head of every request and checks the JWT `exp` first. One of the four rules above is therefore already satisfied. The other three are not, and none of them can be added from outside:
>
> | Rule | `pluggy-sdk` |
> |---|---|
> | lazily per request | already does it |
> | margin | `payload.exp <= now`, so a token with 200ms left passes the check and the request 401s |
> | single-flight | a plain async method; the account fan-out of §14.1 issues N concurrent `POST /auth` |
> | 401 retry | `got` is configured to retry `429` and nothing else |
>
> The cached key is private instance state, so a margin cannot be injected. The SDK also has no rate limiter at all, which puts §16.2's rule ("the limiter goes inside the single send function, so a new endpoint cannot forget it") out of reach as long as the send function belongs to someone else.
>
> **Decision: our own client over `fetch`.** One `send()` carrying the rate limit, the key with its margin and single-flight, the 401 retry, the 429 backoff, and later the pagination of §14.2. `pluggy-sdk` stays installed as a source of types.
>
> **Second finding: the SDK's types are only true inside the SDK.** `item.d.ts` declares `lastUpdatedAt: Date | null`, and that holds because the SDK installs a reviver in `got` (`transforms.js` turns any ISO-8601 string into a `Date`). Parsing raw JSON ourselves, the field is a `string` at runtime while the type says `Date` — the shape of bug §16.2 was written to warn about. So: string unions come from the SDK (`ItemStatus` is `typeof ITEM_STATUSES[number]`, exact at runtime and already the no-`enum` pattern of §13), and records are described with Zod in `pluggy/wire.ts`, where the type is inferred from what we actually parse. That is Phase 0.5's "trust nothing but the raw HTTP body" written as code instead of as discipline.
>
> The rate limit value stays one named constant, defaulting to 360/min. Phase 0.5 step 4 has to settle it; until then the default is chosen on failure mode, since guessing too high costs a 429 and a retry while guessing too low makes the Phase 1 fan-out crawl and look broken.

> **Amendment, 2026-07-26 — the phase grows `manualUpdate`, and two items come off `send()`'s to-do list.** `init` now triggers and waits on a sync per §14.5, which pulled that tool forward from Phase 5. Two of the things `send()` was promised to carry are built because this made them load-bearing: the **429 backoff**, honouring `Retry-After` for a bounded number of retries, and a **second rate-limit window** for `PATCH /items/` at 20/min. Pagination is still Phase 1's.
>
> A third was not on the list and should have been: **the error body**. `classify` threw the status and dropped everything else, so the first real 400 read "Pluggy returned 400 while refreshing connection …" and named neither of the four causes Pluggy documents for it. That is §16.2's scar with our name on it. Every non-2xx now parses Pluggy's envelope and repeats its `codeDescription`, `message` and `canRetryAfterDate`.
>
> What remains for Phase 0.5 step 4 is unchanged, with one addition: the 20/min figure for updates is documented plainly and needs no confirming, but whether the general limit is per minute or per hour still does.

### Phase 0.5 — Reconnaissance before writing feature code

Before any tool exists, hit the API by hand and confirm, against **your** banks:

```bash
curl -H "X-API-KEY: $KEY" "https://api.pluggy.ai/accounts?itemId=$ITEM"
curl -H "X-API-KEY: $KEY" "https://api.pluggy.ai/transactions?accountId=$ACC"
```

Checklist, in descending order of how much a wrong answer would cost:

1. **Is transaction `id` stable across re-syncs?** Fetch a range, force a `manualUpdate`, fetch the same range again, and diff the ids. **§12's entire override design depends on this** — `category_overrides` is keyed on `transaction_id`, and §10 says `cache.db` gets dropped and rebuilt on any schema change. If Pluggy re-issues ids on re-fetch, every override orphans on the first cache rebuild and the two-file split buys nothing for overrides. Nothing else in this ADR establishes this; a `:memory:` SQLite test proves our SQL preserves rows, not that Pluggy preserves ids. If ids turn out unstable, overrides need a synthetic key (date + amount + normalized description) and §12 needs revisiting before Phase 3.
2. **Is Connector 200 / MeuPluggy a regulated Open Finance connector or a Direct one?** Three separate decisions branch on the answer and none of them currently know it: the 7-day freshness window (Phase 1), the `CREDIT` balance semantics (§14.1), and whether `getBills` returning empty is normal (§14.3). Resolve this once, here.
3. **Does an open-bill transaction carry `status: PENDING`, an empty `creditCardMetadata.billId`, or both?** §14.3 and the prior implementation disagree, and `getBillSummary` is wrong if we pick the wrong one. Pull one open and one closed bill and compare both fields on every row.
4. **Is the free-tier rate limit 360/minute or 360/hour?** The project spec records 360/min per IP on `GET /transactions`; the prior implementation hardcodes `maxRequests = 360` over `rateLimitDuration = time.Hour`. That is a 60× difference, it decides whether the transaction fan-out in §14.2 is free or is the binding constraint, and neither source is authoritative — one of them is a mistake. Check the current docs, and if still ambiguous, measure.
5. Confirm `category` / `merchant` really do come back null. **Trust nothing but the raw HTTP body here** — §16 found the prior implementation could not have observed this, because its response serializer strips empty values and its `category` field collapses `null` to `""`, deleting the evidence before a human sees it.
6. Check whether `item.connector` shows the real institution or just "MeuPluggy" — this determines whether `source` can be built at all (§10 denormalization).
7. Check whether `paymentData` carries the counterparty on **your** banks, and how often it is missing — and whether absent arrives as `null` or as an empty-stringed object (§12.2).

Capture the raw JSON as test fixtures. Pluggy's Discord is the support channel for personal use, with answers in hours.

*Answers:* what the data actually looks like, which is the input to every later estimate — and, via (1) and (2), whether §12 and Phase 1 are built on solid ground.

### Phase 1 — Accounts and balances

`getAccounts`, `getBalance`, `getBalanceByAccount`. The lazy cache path in `storage/`, plus the `Clock` port and the 7-day freshness rule — freshness only matters for the last 7 days, since regulated Open Finance connectors update within a 7-calendar-day window including today, and anything older is immutable in practice and must not be revalidated.

*Delivers:* the account map. *Answers:* is the credential/item/account chain sound.

### Phase 2 — Transactions

`getTransactions` (aggregates with capped `sampleIds`), `listTransactions` (paged, `limit <= 100`) and `getTransactionDetails`. Description normalization lands here, because `description_norm` is written on cache insert. The response shape and its token budget must be settled here — this is the tool that can blow a context window.

Note this phase consumes the category list fixed in phase 1, since `getTransactions` takes a `categories?` filter validated against it.

*Delivers:* the core of the product. *Answers:* the real quality of the data, and therefore how much categorization work remains.

### Phase 3 — Taxonomy, MCC and overrides

Research Pierre's taxonomy, fix the N categories, build the MCC → category table, ship `setCategory` and the derived-category query.

**Two halves with different dependencies**, and the earlier version of this ADR wrongly claimed the whole phase "blocks on nothing but a decision":

- *Fixing the category list* is a pure decision, depends on nothing, and should be pulled **forward to Phase 1** — see the ordering note below.
- *Mapping MCC → category* is empirical. §12.4 step 3 says to cover "the codes that actually show up in real statements", which is data from Phase 0.5 and Phase 2. It cannot be completed before them.

**Ordering correction.** §12.4 calls taxonomy "the *first* implementation decision" and §12.12 calls it "Blocks V1", yet it sits fourth here. Both cannot be true. The resolution: **the category list moves into Phase 1** (it is a decision, and `getTransactions` in Phase 2 takes a `categories?` parameter validated against it — a Phase-2 tool cannot consume a Phase-3 artifact). The MCC mapping stays in Phase 3, where the data exists. What "blocks V1" accurately means is "blocks any tool that names a category", not "blocks all work".

Ships `setCategory`, `setCounterpartyCategory`, the `mcc_categories` seed table, and the three-lookup `COALESCE` query of §12.3.

*Delivers:* usable categories across the whole wallet — MCC on cards, counterparty off cards. *Answers:* **what fraction is still uncategorized after override, counterparty and MCC.** That residue is by construction the description-matching gap, and its size is the number that decides whether V2 rules are urgent or optional. Measure it per account type, since cards and checking accounts fail for different reasons.

### Phase 4 — Credit cards

`getBills`, `getBillSummary`, `manageClosingDate`. Settle the `operation`-enum question from §14.3 first.

### Phase 5 — Operations

`manualUpdate` with its hours-long debounce, and `listSources`. Pitfall #7 becomes an explicit error here: empty response → check consent → if revoked or expired, fail loudly instead of reporting "no transactions".

> **Amendment, 2026-07-26 — `manualUpdate` left this phase for Phase 0.** It was here because the debounce looked like it needed persistence; it does not, because Pluggy enforces the interval itself (§11). The poll loop lives in `core/refresh.ts` and `init` is its first caller. What stays here is exposing it as an MCP tool, which is the part that needs §16.4's error split settled, and `listSources`.

### Phase 6 — Installments

`getInstallments`, last, with real data in hand (§14.2).

### Phase 7 — `doctor` and the README

`doctor` as specified in §14.6. The README is a deliverable of this phase, not an afterthought (§1), and it must state the security posture explicitly (§9).

### V2 — Rules

`category_rules` at a new `user_version`, the specificity engine, `addRule` / `listRules` / `deleteRule`, ambiguity detection in `doctor`, and the discoverability design of §12.8.

---

## 16. Prior art: `openfinance-mcp-server`

A Go implementation by the same author, at `../openfinance-mcp-server`, already exposes Pluggy data over MCP. It is a **stateless passthrough**: no cache, no categorization, no migrations, no CLI. `cata-centavo` is a superset, so the useful question is not "what does it do" but "what did it already pay for".

Caveat that governs everything below: **only `internal/provider/sqlite` and `internal/provider/secret` have tests.** The entire Pluggy client and all twelve tool handlers are unverified. Treat its behaviour as *observed practice*, not proven correctness — several findings here are bugs, not patterns.

### 16.1 Adopt

**Domain vocabulary and the description template** — already promoted to §14.0.

**The TTL store, wholesale.** A single KV table (`key`, `value`, `expires_at`), lazy expiry on read, `ttl <= 0` meaning permanent, no sweeper, and a **clock injected as a struct field** — which is what makes its TTL test deterministic without a fake-timer library, and maps directly onto our `Clock` port (§7). Keys namespaced by a `prefix:name` convention. Right shape for our API key and connect tokens.

**Its two best tests, as templates for §9.** One seals a value, reads the raw blob back with a direct query, and asserts the plaintext is *not* present on disk — verifying the property, not that a function was called. The other reopens the same file with a different key and asserts failure. Both are worth copying almost literally.

**SQLite pragmas:** `journal_mode=WAL`, `busy_timeout=5000`, and a max of one open connection, with the comment "*a single local writer avoids SQLITE_BUSY*". We have exactly one writer too.

**The poll-and-wait shape for `manualUpdate`** (§14.5): 2s initial backoff, doubling, capped at 30s, bounded retry count, cancellation checked both at the loop head and inside the sleep. It is the one well-built retry in the repo. **One change:** it treats anything other than `UPDATING`/`UPDATED` as terminal and therefore rejects `PARTIAL_SUCCESS`, which §14.5 requires us to accept.

> **Amendment, 2026-07-26 — adopted in `core/refresh.ts`, with two changes rather than one.** The backoff is verbatim: 2s, doubling, 30s ceiling, 40 attempts, a little over eighteen minutes against a documented five-minute worst case for the login step alone. `PARTIAL_SUCCESS` is accepted, as required.
>
> The second change is the inverse of the first. Rather than widening the "keep going" set to admit `PARTIAL_SUCCESS`, the loop narrows it to `UPDATING` alone and treats everything else as terminal — which is what Pluggy's own polling recipe does. Enumerating the states worth continuing on is the bug: get the enum wrong and an unknown status spins for the full eighteen minutes. Enumerating the states worth *stopping* on cannot fail that way.
>
> Cancellation is the one part not adopted. In-loop checks earn their keep when this is an MCP tool a client can cancel without killing the process; today the only caller is `init`, where Ctrl-C ends the process and the handler's job is just to give the cursor back.

**The liquidated-investment filter, verbatim including all three conditions:** skip when `status == "TOTAL_WITHDRAWAL" && balance == 0 && amount == 0`. Pluggy returns fully-withdrawn positions forever. The three-way `AND` is itself the finding — status alone was evidently not sufficient. Also strip the nested `transactions[]` array a position carries; it is unbounded and will dominate a response.

**The bounded response shape of the current-bill tool:** seven scalars plus exactly five top transactions. It is the only payload in the repo that respects a context window, and it is the model for `getBillSummary`.

**The three response helpers** (`validationError`, `toolError`, `jsonResponse`), extracted *after* the tools were written rather than designed up front. The value is that every handler's happy path and every failure path is one line, so the body holds only domain logic.

### 16.2 Avoid — scars that are bugs

**The response serializer strips `0` and `false`.** A shared `stripEmpty` deletes any zero number, empty string or false boolean before the model sees it. In a financial tool a balance of exactly `0` disappears, and `0` and "not reported" become indistinguishable. **Strip only `null`/`undefined`, never falsy values.** Adopt the idea of one shared serializer; reject this policy.

**It round-trips money through `float64`.** The serializer marshals, unmarshals into an untyped map, and re-marshals — so exact decimals decode into floats and the precision library upstream is defeated at the boundary. **Pick one money representation (integer cents, or strings) and never let a value pass through a JS `number`.**

**These two combined hid a fact from the author.** Its `Transaction.Category` is a non-nullable string, so Pluggy's `null` becomes `""`, and the stripper then removes the field. The repo could never have observed that free-tier `category` comes back null — the evidence was deleted before a human could see it. This is why Phase 0.5 step 5 says to trust the raw HTTP body only.

**`Fatal` is called from inside the provider layer** — seven times, on missing credentials, unreadable config, store failures and auth failure — and the client constructor performs network I/O before any tool is registered. So bad credentials or a Pluggy outage exits the process before the MCP handshake, and the user sees "server failed to start" with the explanation in a log file they don't know exists.

**This is the one place our architecture must consciously diverge.** `doctor` and `init` (§14.6) exist to *report* exactly these conditions, and cannot report a condition that terminates the process. Every credential, config and auth failure is a returned error; client construction is pure and connects on first use.

**The logger falls back to stdout.** If the log file cannot be opened, every log call writes protocol-corrupting text into the JSON-RPC channel — and the handlers log heavily. This is the concrete failure mode behind §4's stderr rule: **the fallback must be stderr, never stdout.** Relatedly, it logs a live 30-minute bearer token into a `0666` file. No secret value is ever an argument to a log call, and the log file gets the same `0600` as everything else.

**The rate limiter is wired to two of nine endpoints.** It exists, it works, and seven call sites simply forgot to invoke it — including the item-status poll, which fans out concurrently across all connections. **Put the limiter inside the single HTTP send function** so a new endpoint cannot forget it. (The limit *value* is disputed — see Phase 0.5 step 4.)

> **Amendment, 2026-07-26 — one send function, now two windows.** `PATCH /items/{id}` is limited to 20/min where everything else gets 360, so a single shared window would let a fan-out of reads spend the update budget. Both windows are claimed inside `transport`, which is the same lesson applied twice: the choke point decides, not the call site.
>
> This section also acquired a scar of our own, in the same family as the serializer above. `classify` built its message from the status code and discarded the response body, so the first real 400 from `PATCH /items/{id}` said "Pluggy returned 400" and named none of the four causes Pluggy documents for that status. The evidence was deleted before a human could see it, again, and it took a live credential to notice. **Every non-2xx body is parsed and its explanation repeated.**

**A declared tool parameter that never reaches the wire.** One transaction filter is parsed, validated, logged and assigned to a struct field that the query builder never reads. The tool advertises a filter that does nothing. **Every tool parameter needs a test proving it reaches the request.**

**Two npx-hostile details:** it auto-loads a `.env` from the *current working directory*, which under `npx` is arbitrary; and an earlier commit embedded credentials into the binary at build time, since reverted. No cwd-relative config, no build-time secrets.

### 16.3 The storage split, stated explicitly

Its sealed KV store cannot be extended to hold transactions, and the temptation to generalize one `Store` interface over both is real — the failure would be discovered late and be expensive.

Two independent blockers: values are AES-GCM sealed and therefore **opaque to SQL**, which makes §12.3's "derive the category inside one query" impossible; and a JSON-blob-per-key KV cannot express `WHERE date BETWEEN` or a `COALESCE` join at all. **Two storage abstractions, deliberately: a sealed KV for secrets, and a typed relational cache for data.**

This also explains why the prior art needs no migrations and we do (§10): a single generic KV table is structurally immune to schema change. That immunity does not transfer to a typed `transactions` table.

### 16.4 An unresolved design question it surfaces

Its error helpers return **both** a response object and a non-nil error. In MCP those are different channels: a protocol-level error, whose text the model may never see, versus an `isError` tool result the model can read and act on. Returning both leaves the choice to the SDK.

**Decide per case, and record it.** Anything the model should recover from — revoked consent (§14.5), an unknown `connectionId`, legitimately empty bills (§14.3) — must be readable `isError` content, not a thrown error. Getting this backwards turns our loudest, most carefully designed failure into an opaque transport error.

### 16.5 Evidence for two decisions already taken

A Python script in the repo computes the bill formula outside the binary. Its history explains it: a skill file first taught the *model* to do the arithmetic, then a script was offered "when precision is needed", then it was promoted into a real tool. Neither earlier rung was deleted.

That is direct evidence for §14.2's choice to make `getInstallments` a derived server-side tool rather than a prompt — the author already tried the prompt route and abandoned it. It is also a standing warning: **the moment you find yourself writing instructions telling the model how to combine two tool outputs, that combination belongs in a tool.** Note this is distinct from §12.8's plan, which uses tool *descriptions* to advertise a capability rather than to teach an algorithm.

---

## Branches not yet walked

Decisions this document names but does not make. Each says what it blocks, so a session picking up the ADR knows whether it can proceed.

- **Cache freshness by range** — how to know whether `[from, to]` is partially cached. `fresh(accountId, from, to)` is still hand-waved, and it is load-bearing for every read path. Blocks phase 1.
- ~~**Config format versioning** written by `init`. Blocks phase 0.~~ **Closed 2026-07-25** by removing the config file: configuration is environment-only (§4). Reopens the day a config file returns, and the answer waiting for it is an integer `version` field with a forward migration chain, refusing to guess when the file is newer than the binary.
- **Test fixtures without committing real bank statements** to a public repository (§1 makes the repo public). Blocks phase 0.5, which is where fixtures get captured.
- **`camelCase` or `snake_case`** for tool names (§14.0). Mechanical to apply, expensive to change after the README documents it. Blocks phase 1.
- **The `isError`-content versus protocol-error split** (§16.4), per failure class. Our loudest designed failure — revoked consent — is worthless if it lands in the channel the model cannot read. Blocks phase 1.
- **The aggregate grouping of `getTransactions`** — `sampleIds` and the cap are settled (§14.2), but *what the groups are* (category? merchant? account? month?) is not, and the token budget follows from it. Blocks phase 2.
- **`manageClosingDate` as one tool with an `operation` enum, versus three verbs** (§14.3). Blocks phase 4.

Two more are empirical rather than decisions, and Phase 0.5 exists to answer them: transaction id stability across re-sync (which §12's whole override design rests on) and whether Connector 200 is a regulated or Direct connector (which three separate decisions branch on blindly).

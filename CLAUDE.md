# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`cata-centavo` is an MCP server that exposes Brazilian Open Finance data (via Pluggy) to an agent. The binary is a CLI whose default mode — no argument — is the MCP server over stdio.

`docs/adr/0001-stack-and-architecture.md` is the source of truth for every engineering decision here, including the ones still open. **Read the relevant section before implementing anything.** It is long, and it flags which phases are safe to start (0 and 0.5) and which depend on unanswered questions. When the ADR and this file disagree, the ADR wins.

## Commands

**Run `nvm use` first.** This machine's default node is v18, and the failure mode is misleading: a single test file dies with `ERR_UNKNOWN_FILE_EXTENSION`, while `npm test` reports `# tests 0` and exits 0 — a green run that executed nothing.

```bash
nvm use                  # reads .nvmrc → v24.15.0

npm run dev              # run the CLI from source (node executes .ts directly)
npm run typecheck        # tsc --noEmit — this is the linter, see below
npm run lint             # eslint como sensor — avisos informam, erros reprovam
npm test                 # node --test, finds tests/**/*.test.ts
npm run test:watch
npm run build            # tsc -p tsconfig.build.json → dist/
```

Run a single test file or a single test:

```bash
node --test tests/cli/dispatch.test.ts
node --test --test-name-pattern="unknown command"
```

**Always run `npm run typecheck` before `npm run lint` before `npm test`.** Node strips types without checking them: `const x: number = "string"` runs fine. Without `tsc`, the project has no type checking at all. Typecheck first, then lint, then tests, then build — the same order CI uses.

## Runtime constraints that bite

- **Node 24 (`.nvmrc` = v24.15.0)**, native type stripping, no `tsx`/`ts-node`, no build step in dev.
- **No `enum`, no parameter properties** (`constructor(private x)`). `erasableSyntaxOnly` rejects them at tsc time because they crash at runtime with `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`. Use a `const` object plus a derived union — see `src/cli/dispatch.ts` for the pattern.
- **Source files import `.ts` extensions** (`from "./balance.ts"`). `rewriteRelativeImportExtensions` turns them into `.js` on build.
- **Nothing but JSON-RPC may reach stdout.** In server mode stdout *is* the protocol channel. Every human-facing message, log line and error goes to stderr, always — including any fallback path in a logger.
- `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` are on deliberately. The first guards the pagination loops where a bad index means missing money; the second enforces "absence is `NULL`, never `''`".

## Architecture

```
src/
├── core/          business rules. no fetch, no sqlite, no SDK
│   └── contracts.ts    interfaces core requires of whoever serves it
├── pluggy/        client.ts · mapper.ts · errors.ts
├── storage/       db.ts · schema.sql · store.ts
├── mcp/           server.ts · format.ts · tools/
├── cli/           init.ts · doctor.ts · dispatch.ts
├── config.ts
└── bin/cata-centavo.ts
tests/             mirrors src/, plus fakes/ and fixtures/
```

**The rule holding it together:** `src/core/` imports nothing from `src/pluggy/`, `src/storage/` or `src/mcp/`. Contracts live in `core/contracts.ts` because the interface belongs to the consumer, not the implementer. This is currently convention, not enforcement — no tooling checks it.

No `services/`, no `utils/`, no `ports/`/`adapters/`. Tests live in `tests/`, not colocated, which is what lets the build tsconfig be `include: ["src"]`.

**Two storage abstractions, deliberately kept apart:** a sealed KV for secrets (AES-256-GCM via `node:crypto`, opaque to SQL) and a typed relational cache for data. Do not generalize one `Store` over both — the sealed values cannot participate in a query, and category derivation happens *inside* the SQL.

**Two SQLite files** (`node:sqlite`, zero native deps): `cache.db` under `XDG_CACHE_HOME` is droppable and rebuilt from Pluggy; `data.db` under `XDG_DATA_HOME` holds overrides, rules and closing days and is never dropped. Versioned with `PRAGMA user_version`.

**Speak the user's domain, not Pluggy's.** Tools take `connectionId`, never `itemId`. The vocabulary mapping stays inside `pluggy/mapper.ts`.

**Derive, don't store.** A transaction's category is computed at read time by one SQL query (`COALESCE` over override → counterparty → MCC). Never materialize a `category` column.

## Development guidelines

### Code quality process

1. `npm run typecheck` before `npm run lint` before `npm test` — the typecheck catches what the test runner never will.
2. All three must pass before you consider a change done. CI runs typecheck → lint → test → build.
3. Keep the devDependency list at two entries (`typescript`, `@types/node`) unless there is a decision to add a third. Dependency minimalism is a stated value of this project, not an accident.

### Comments

**Avoid comments. Write docblocks instead.** A `/** */` above an exported function, type or non-obvious constant is welcome; inline commentary explaining *what* the next three lines do is not — extract a named function. Comments that survive are the ones recording a decision the code cannot express: a runtime gotcha, an ADR reference, a "this looks wrong and here is why it isn't".

Run text through the `humanizer` skill when writing prose (docblocks, README, ADRs, PR descriptions) to strip AI tells.

### Testing

- **TDD, always.** Red → green → refactor. Write the failing test before the implementation.
- **Look for an existing test file before creating a new one.** `tests/` mirrors `src/`; a new case usually belongs in a file that already exists.
- **Prefer table tests** over several near-identical `it()` blocks: one array of cases, one loop, one assertion body. `tests/cli/dispatch.test.ts` iterates `Object.values(COMMANDS)` in that spirit.
- Pure logic (normalization, category resolution, mapping) is tested in `tests/core/` with no I/O.
- Storage is tested against SQLite `:memory:`, including the two-file `ATTACH` form.
- External dependencies are faked from `tests/fakes/` — `fake-bank.ts`, `fixed-clock.ts`, `fake-store.ts`. Those live outside `src/` precisely so production code cannot import them.
- `t.mock.timers` covers the injectable `Clock` and freshness rules; no fake-timer library.
- Capture raw Pluggy JSON as fixtures in `tests/fixtures/` — but the repo is public, so never commit real statements.
- **Every tool parameter needs a test proving it reaches the request.** The prior Go implementation shipped a declared filter that was parsed, validated and then never read.

### MCP tool development

- Every tool description follows the same three-part template, because descriptions are the only discovery surface a model gets:

  ```
  <one line: what it does>

  Use this tool when:
  - <situation>

  Returns: <what comes back, in domain terms>
  ```

- Validate input with Zod at the boundary. Categories are a closed list — free-form strings let an agent invent `alimentacao` and `alimentação` in one database.
- Return **our** shape, never Pluggy's pagination envelope. Aggregates by default; detail through explicitly bounded paths with a hard cap.
- Decide per failure whether it is a protocol error or `isError` tool content. Anything the model should recover from — revoked consent, unknown `connectionId`, legitimately empty bills — must be readable content, or the loudest designed failure lands in the channel the model cannot see.
- Never `process.exit` from a provider or client layer. `init` and `doctor` exist to *report* credential and connectivity failures, and they cannot report a condition that kills the process. Client construction is pure; connect on first use.
- Strip only `null`/`undefined` when serializing — never falsy values. A balance of exactly `0` disappearing is a financial bug.
- Never let money pass through a JS `number`. Pick integer cents or strings and hold the line at every boundary.
- Rate limiting belongs inside the single HTTP send function, so a new endpoint cannot forget it.
- Paginate to the reported `totalPages`, with `pageSize = 500`. Terminating on a short page is how aggregates get silently computed over a fraction of the data.

## Working agreement

**Start every feature with:** "Let me research the codebase and create a plan before implementing."

Research → Plan → Implement → Validate. Propose the approach and confirm it before building; run typecheck and tests after.

- **Do not commit unless asked.** Not at the end of a task, not "to be safe".
- Prefer a simple, functional, testable shape over a flexible one. We ship useful software.
- Keep functions small. If a comment is needed to explain a section, that section is a function.
- This is always a feature branch: delete old code outright. No `processV2`, no `handleNew`, no deprecation shims, no "removed code" comments, no migration code unless asked for.
- Explicit over implicit: clear names over clever abstractions, direct dependencies over service locators.
- When stuck, stop — the simple solution is usually right. When choosing, ask: "A (simple) vs B (flexible), which do you prefer?"
- Batch independent work: parallel reads and searches in one message, related edits grouped.

# Dependency rules as a sensor

State: validated in conversation, 2026-07-26. Closes ADR §181, which named `dependency-cruiser` as one of two options and deferred the choice to phase 1. Supersedes the paragraph in [2026-07-26-eslint-and-logging-design.md](2026-07-26-eslint-and-logging-design.md) that claimed `no-restricted-imports` had already closed it.

## Why a second tool for a rule we already enforce

`eslint.config.js` has a `files: ["src/core/**"]` block with `no-restricted-imports` barring `pluggy/`, `storage/`, `mcp/` and `pluggy-sdk`. Yesterday that looked like the whole answer. It is not, because ESLint reads one file at a time and half the architecture is a property of the graph.

**Decision: the boundary moves to `dependency-cruiser`, and the `src/core/**` block leaves `eslint.config.js`.** Architecture rules live in one place. ESLint goes back to being a sensor of shape (complexity, size) and correctness (`no-console`, `no-floating-promises`).

The cost is real: the violation stops appearing in the editor in milliseconds and starts appearing in a separate command. Accepted, because two configs expressing the same rule in two syntaxes will diverge, and the day they diverge nobody will notice.

## What one file cannot see

Bench run against the current tree, 22 modules and 37 dependencies:

`src/storage/db.ts → migrations.ts → db.ts` is a cycle. It has been there since the file was written and no per-file linter can see it.

`src/core/contracts.ts` is imported exclusively through `import type`. That single fact decides the configuration below.

## The rules

| name | severity | what it catches |
|---|---|---|
| `core-imports-no-infrastructure` | error | `src/core/` reaching into `pluggy/`, `storage/`, `mcp/` |
| `core-imports-no-packages` | error | any npm package inside `src/core/`, `zod` excepted |
| `only-bin-builds-infrastructure` | error | `cli/` or `mcp/` importing `pluggy/`, `storage/` or `logging.ts` |
| `no-cycles` | error | any import cycle |
| `src-imports-no-tests` | error | production code reaching a fake |
| `no-dev-dependencies-in-src` | error | a devDependency shipped by accident |
| `no-undeclared-folders` | error | a folder under `src/` the ADR does not list |
| `no-orphans` | warn | a module nothing imports and that imports nothing |

Two of these deserve their reasoning written down.

`core-imports-no-packages` is stricter than the ADR asked for. The ADR names `pluggy-sdk`; this bars every npm package from `core/`, with `zod` named as the exception because §404 already promises it to `core/category.ts`. The rule then needs no maintenance: a new dependency that lands in `core/` fails on its own, without anyone remembering to add it to a list.

`only-bin-builds-infrastructure` is the one rule here that describes code not yet written. It holds today — `cli/init.ts` takes its `Bank` as a parameter and `bin/` does the wiring — and it is what §16.4 depends on when it says a provider may never call `process.exit`. Freezing it before `mcp/` exists is the point. Afterwards it would be a migration.

`no-undeclared-folders` has an honest limit. `dependency-cruiser` reasons about edges, not about which files exist, so it catches a new folder the moment something imports it. A folder nobody imports slips past this rule and lands in `no-orphans` instead.

## The flag that decides the configuration

`tsPreCompilationDeps: true`. Turn it off and the cruise drops from 37 edges to 25, because `import type` disappears at runtime. `src/core/contracts.ts` then has no incoming edges and the sensor reports it as an orphan. The file the ADR uses to justify the entire architecture would be flagged as dead code.

Leaving it on has the inverse price: the `db.ts ⇄ migrations.ts` cycle is type-only, and it still fails. `dependencyTypesNot: ["type-only"]` does not suppress it — the filter applies to the first hop, which is an ordinary `import`, while the type-only edge sits inside the `cycle` array.

That is the correct outcome anyway. A type cycle is still a reading cycle: you cannot understand `migrations.ts` without opening `db.ts`, and the other way round.

`extensions: [".ts", ...]` with `.ts` first is what makes `from "./wire.ts"` resolve. Verified.

## Day one

One error: the storage cycle. `migrations.ts` imports `type Migration` from `db.ts` while `db.ts` imports the migration arrays back.

`Migration` describes a migration, not a database. It sits in `db.ts` by accident. Moving the type to `migrations.ts` leaves a single direction, `db.ts → migrations.ts`, which already exists. One line, no new file.

## The reporter

`tools/depcruise-reporter-agent.js`, sibling to `tools/eslint-formatter-agent.js`. The contract is `(cruiseResult) => { output, exitCode }`, so no dependency is involved.

One design difference from the older sibling, and it is an improvement. In ESLint the guidance lives in a `rule → text` map inside the formatter, because the rules belong to other people and have nowhere to hang prose. These rules are ours. The text lives in each rule's `comment` field in `.dependency-cruiser.js`, and the reporter reads it back from `summary.ruleSetUsed.forbidden[]`. One source, and the native `err-long` keeps printing the same guidance for whoever runs it by hand.

The reporter does three things `err-long` does not. It groups by rule. It prints the guidance once per group rather than once per violation, which was measured, not assumed: ten violations of one rule produce ten copies of the same paragraph today. And it renders a cycle as a path instead of a pair.

`exitCode: summary.error`, so warnings never fail. Same reading of the article as the ESLint gate.

Tested in `tests/tools/depcruise-reporter-agent.test.ts`, next to the local-rules test. The fixture is a synthetic `cruiseResult`; no I/O, no real cruise.

## Gate

`npm run deps`, separate from `npm run lint`. Different tools, different failures, and running one alone stays useful.

CI becomes `typecheck → lint → deps → test → build`.

## Dependency cost

CLAUDE.md asks for two devDependencies unless there is a decision. This is the decision, and it is the expensive one so far.

devDependencies goes from 4 to 5. `dependency-cruiser@18.1.0` pulls 18 direct dependencies of its own, including `acorn`, `enhanced-resolve` and `commander`. Nothing here reaches the published package — `files` is `["dist", "README.md", "LICENSE"]` — but it is the largest thing in the tree.

ADR §181 predicted the price exactly and asked for the decision at phase 1. Taken.

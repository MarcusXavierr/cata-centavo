# Mutation testing as a sensor, with Stryker

Status: implemented 2026-07-26. Third sensor in the series that `docs/plans/2026-07-26-eslint-e-logging-design.md` started and `docs/plans/2026-07-26-dependency-rules-design.md` continued.

## What it answers that nothing else does

`npm test` proves the tests run. It does not prove they assert. ESLint reads shape, `tsc` reads types, `depcruise` reads direction. None of them reads whether a test would notice if the code were wrong.

ADR §16 records the predecessor shipping exactly that failure: a transaction filter parsed, validated, logged, assigned to a struct field the query builder never read. A declared parameter that never reaches the wire. Coverage would have called that line green, because it was executed. An assignment whose removal changes nothing observable is a surviving mutant by definition, and that is the one instrument that catches it.

Böckeler's article is blunter about this than about any of its other sensors:

> In the regression testing area, my eyes have really been opened to how crucial mutation testing becomes when we make the decision to leave most of the testing to AI.

## The runner

There is no `node:test` runner for Stryker. [stryker-js#5421](https://github.com/stryker-mutator/stryker-js/issues/5421) is open and [#6020](https://github.com/stryker-mutator/stryker-js/pull/6020) is unmerged. ADR §7 rejected every framework Stryker does ship a runner for, except tap.

**Decision: `@stryker-mutator/tap-runner`.** It spawns `node --test-reporter=tap <file>` per test file and parses the output, which is what `node --test` already emits. Stryker's own e2e suite carries a fixture named `tap-using-node-test` whose package is `"type": "module"` with `"test": "node --test"` — this exact stack is supported deliberately, not by accident.

Verified on the bench before installing anything: on Node v24.15.0, `node --test-reporter=tap tests/core/refresh.test.ts` emits valid TAP and passes all 16 tests, and so does the `-r <preload>` form the runner actually uses. Native type stripping, `.ts` import extensions and TAP output already coexist. No `tsx`, no `buildCommand`, no `nodeArgs` override.

The `command` runner was the fallback and is not needed. It would have forced `coverageAnalysis: "off"` and run the whole suite per mutant.

Two traps avoided:

`--test-reporter=tap` became the default `tap.nodeArgs` in Stryker 9.0. Node 23 changed its own default reporter from `tap` to `spec`, which made every mutant report `n/a` and produced a fake 100% score ([stryker-js#5287](https://github.com/stryker-mutator/stryker-js/issues/5287)). Fixed upstream; do not copy older configs that predate it.

`tap.testFiles` is set explicitly. The default glob also matches `dist/tests/config.test.js`, and `dist/` exists on disk after any `npm run build`, so the sandbox would have copied and run the compiled tests too. `ignorePatterns: ["dist", "docs"]` closes the same hole from the other side.

`--since` does not exist in StrykerJS. It is a Stryker.NET feature that was never ported. The substitute is `--incremental --force --mutate <files>` driven from `git diff`, which the docs confirm still produces a complete report. Left documented rather than scripted: an empty diff produces an empty `--mutate` and Stryker then errors unless `allowEmpty` is set, so a `mutation:since` script would break on a clean tree.

## What was rejected

`@stryker-mutator/typescript-checker` reclassifies mutants that fail to compile so they do not count as survivors. That problem does not exist here — Node strips types without checking them, so a type-invalid mutant still runs. It would cost a `tsc` program per mutant batch, which is the most expensive thing available to add, against a sensor whose whole value is being cheap enough to run. It also carries a trap: `disableTypeChecks` defaults to `true` and stamps `// @ts-nocheck` on every file, silencing the errors the checker exists to find. Revisit only if a cluster of obviously-uncompilable survivors appears.

`ignoreStatic` stays off. The tap runner folds static coverage into per-file coverage, so module-level constants like `POLL` get attributed to the files that load them rather than orphaned. Turning it on discards real mutants.

## Gate

`"thresholds": { "break": null }`. The sensor reports; it never cancels. Same reading as the ESLint work, and the article is explicit that mutation testing sits on the advisory side with the coupling metrics rather than with the blocking checks.

**Not in CI.** A full run is 48 seconds locally and the score is a conversation, not a pass mark. The article ran it the same way:

> It is quite resource intensive. In my setup I didn't run it continuously (like some of my other sensors), but triggered incremental runs manually.

CI stays `typecheck → lint → deps → test → build`.

## Scope

`src/core/**` and `src/pluggy/**`. The pure logic and the boundary translation, where a surviving mutant means wrong money. `src/cli/`, `src/bin/`, `src/storage/` and `src/logging.ts` are out for now, because CLI mutants are mostly changed human-facing strings and that is noise. Widen when this scope stops producing findings.

Seven files match; `core/contracts.ts` is all types and generates nothing, so six files carry mutants.

## The reporter

`tools/stryker-report-agent.js`, reading `reports/mutation/mutation.json`. Stryker's contract is a JSON file on disk, so no plugin API and no new dependency. The same trick that made the ESLint formatter free.

The raw report is a few hundred kilobytes and must never reach an agent's context. That is the entire reason the file exists. The article's author solved it identically with a `query_stryker.py` exposing `summary`, `files`, `hotspots` and `tests`.

Groups by mutator, not by file, for the reason the ESLint formatter groups by rule: the reader gets "thirty-one branches flip without a test noticing, here is what to do about a branch" instead of thirty-one files with one cryptic line each. Guidance lives in a `mutator → string` map at the top; a mutator missing from it still renders, so a Stryker upgrade never breaks the script. A `Hotspots` block follows, because mutation has a second useful axis that lint does not.

Score arithmetic is Stryker's own — detected over viable, with `Ignored`, `CompileError` and `RuntimeError` excluded from both. `scoreCovered` is reported next to it: a high covered score beside a lower total score means the gap is untested code rather than weak assertions. Both figures match Stryker's own table exactly.

Tested in `tests/tools/stryker-report-agent.test.ts`, following the precedent `tests/tools/eslint-local-rules.test.ts` set, with a hand-written `.d.ts` so the `.js` type-checks from TypeScript.

## Day one

453 mutants over six files, 48 seconds, one test run per mutant on average.

| | mutation score | covered | killed | timeout | survived | no coverage |
|---|---|---|---|---|---|---|
| all | 74.83 | 76.54 | 321 | 15 | 103 | 10 |
| `core/refresh.ts` | 86.96 | 87.72 | 99 | 1 | 14 | 1 |
| `pluggy/client.ts` | 87.76 | 89.58 | 43 | 0 | 5 | 1 |
| `pluggy/errors.ts` | 59.49 | 61.84 | 47 | 0 | 29 | 3 |
| `pluggy/mapper.ts` | 91.67 | 95.65 | 22 | 0 | 1 | 1 |
| `pluggy/transport.ts` | 65.82 | 67.53 | 90 | 14 | 50 | 4 |
| `pluggy/wire.ts` | 83.33 | 83.33 | 20 | 0 | 4 | 0 |

Undetected by mutator: 39 `StringLiteral`, 31 `ConditionalExpression`, 9 `BlockStatement`, 8 `EqualityOperator`, 7 `ArithmeticOperator`, 6 `LogicalOperator`, 3 each `ObjectLiteral` and `Regex`, 2 each `ArrowFunction`, `ArrayDeclaration` and `OptionalChaining`, 1 `MethodExpression`.

## Calibration

The ESLint sensors were calibrated against the real p50/p90 of the code rather than taste. The equivalent step here is reading survivors by hand and deciding which are defects, because a score computed over noise is worth nothing.

`StringLiteral` at 39 of 113 looked like the obvious global exclusion and turned out not to be. Twenty-one of them are the `STAGES` map in `core/refresh.ts`, spinner text where asserting each label would pin wording no caller reads. The rest are in `pluggy/errors.ts`, where the message *is* the product. ADR §16.4 requires a model to recover from those, so they deserve assertions.

So the map is suppressed at the site, with a reason, rather than the mutator being excluded globally:

```ts
// Stryker disable StringLiteral: spinner text, not behaviour — asserting each label would pin wording no caller reads
```

This is the article's escape valve, and it matches what `local/require-disable-reason` already enforces for ESLint: suppression is allowed, silent suppression is not. Ignored mutants leave the score entirely rather than counting as killed.

The survivors that remain are real. Spot-checked:

- `transport.ts:176` — `now < key.expiresAt` loosens to `<=` unnoticed. The cache boundary has no test.
- `errors.ts:79` — `response.status === 404 ? null : …` flips to `!==` unnoticed. The docblock right above it explains why 404 keeps our sentence instead of Pluggy's. A decision recorded in prose and enforced by nobody.
- `wire.ts:90` — `\s+` loosens to `\s` unnoticed. The pattern is only ever tested against inputs the loosened version also matches.

## The defect it found

`transport.ts:206`:

```ts
return (jwtExpiry(token) ?? now + KEY_FALLBACK_LIFETIME_MS) - KEY_MARGIN_MS;
```

`now +` mutates to `now -` and all 138 tests stay green. An API key that is not a JWT, with no `exp` claim to read, would be born two hours and ten minutes expired, and the client would re-authenticate on every single request instead of once. Nothing in the suite reached the fallback, because `fakeJwt` always produces a well-formed token.

Killed by a test using an opaque key, in `tests/pluggy/client.test.ts`. It took five other mutants on lines 205–213 with it.

That is the sensor paying for itself on the first run: not a style opinion, a live defect in credential handling that four other sensors and 138 passing tests did not see.

## After calibration

78.27% overall, 79.76% of covered code. 335 detected of 428 viable, 85 survived, 8 never covered, 21 ignored.

Undetected by file: `transport.ts` 46, `errors.ts` 32, `client.ts` 6, `wire.ts` 4, `refresh.ts` 3, `mapper.ts` 2.

`transport.ts` and `errors.ts` are where the next work is. Neither number is a target; they are the baseline the next run gets compared against, which is the point the article makes about trends beating snapshots.

## Cost in dependencies

CLAUDE.md asks for a written decision before the devDependency list grows. This is it.

devDependencies goes from 5 to 7: `@stryker-mutator/core` and `@stryker-mutator/tap-runner`, both pinned to the same minor because Stryker's internal peers are exact.

The honest number is not 2. Measured on install: **134 packages added**, taking the tree from 265 to 399. Core alone pulls `@babel/*` through the instrumenter, plus `rxjs`, `execa`, `ajv` and `@inquirer/prompts`. That is by a wide margin the largest single increase this repo has taken, against an ADR that names dependency minimalism a first-class value in §5.

Paid because it is dev-only, absent from `files`, never shipped to a user, and because it is the only tool here that answers a question the other four cannot. The first run returned a live defect in credential handling. That is the evidence.

If a later run stops returning findings, this is the sensor to drop first. The article's own test is that a sensor which never fails is a sensor you do not need.

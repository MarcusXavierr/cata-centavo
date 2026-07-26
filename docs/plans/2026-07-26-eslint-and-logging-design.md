# ESLint as a sensor, and logging with Pino

State: validated in conversation, 2026-07-26. Replaces the question ADR §179 left open about enforcing import direction.

> **Amendment, 2026-07-26 — the import-direction part of this document was withdrawn the same day.** "The core boundary" below claimed `no-restricted-imports` closed ADR §179 for free. It did not: ESLint reads one file at a time, and a cycle, an orphan and a composition-root violation only exist in the graph. The boundary moved to `dependency-cruiser` and the `src/core/**` block left `eslint.config.js`. See [2026-07-26-dependency-rules-design.md](2026-07-26-dependency-rules-design.md). Everything else here still holds.

## The blocker that decides everything

`typescript-eslint` refuses TypeScript 7. Not a warning: a `throw` at import time, and it applies even to purely syntactic linting — `@typescript-eslint/parser` on its own fails the same way. Support only arrives for TS ≥ 7.1 ([typescript-eslint#10940](https://github.com/typescript-eslint/typescript-eslint/issues/10940)).

Verified on the bench: with `typescript@6.0.3` everything works on Node 24, type-aware linting included, in 2.7s across the whole project. `tsc` 6.0.3 exits 0 with zero diagnostics against the current `tsconfig.json`, without touching a single flag, and all 56 tests pass. The flags this project depends on (`erasableSyntaxOnly`, `rewriteRelativeImportExtensions`, `exactOptionalPropertyTypes`) all date from 5.8 or earlier.

**Decision: downgrade to `typescript@~6.0.3`.** The `~` is not style. typescript-eslint's peer range is `>=4.8.4 <6.1.0`, so `^6.0.3` would allow 6.1.0 to resolve and silently reintroduce the block on some `npm update`.

Revisit when TS 7.1 ships.

## The Factory plugin: rejected

`@factory/eslint-plugin` prompted the investigation and does not go in. Three reasons, heaviest first.

`no-exported-string-union-types` exists to force an enum in place of a string union. It collides head-on with `erasableSyntaxOnly`, which exists precisely because enums break at runtime under Node's type stripping. `enum-file-organization` assumes the same world.

`test-file-location` demands tests sit next to the source. CLAUDE.md records that the mirrored `tests/` is deliberate, and it is what allows `include: ["src"]` in the build tsconfig.

The plugin's own README asks you not to import it: *"Our recommendation is NOT to simply import this package."* It sits at 0.1.0 and documents only `.eslintrc`, while ESLint 10 accepts flat config alone.

What survives from it is the idea of restricting organisation by path, and for the case that matters here ESLint's core `no-restricted-imports` handles it.

## Sensors

Thresholds calibrated against the code's actual distribution, not picked out of the air. In `src/`, complexity has a p50 of 3 and a p90 of 5, with a maximum of 8. Lines per function has a p50 of 11 and a p90 of 22.

| rule | limit | level |
|---|---|---|
| `complexity` | 6 | warn |
| `max-lines-per-function` | 50 | warn |
| `max-params` | 4 | warn |
| `max-depth` | 3 | warn |
| `max-statements` | 16 | warn |
| `max-lines` | 250 | warn |

`skipComments` and `skipBlankLines` on for every rule that accepts them. Without that the sensor punishes the ADR-citing docblock style CLAUDE.md requires.

All off in `tests/`. Measured: counting `describe()` as a function produced four false warnings, one of them on a 145-line block that is a container, not a defect.

Day one in `src/`: four warnings. `resolveInvocation` (complexity 8), `readItemIds` (7), `jwtExpiry` (7) and `createPluggyClient` (63 lines).

## Correctness

Level `error`, they fail the build.

`no-floating-promises`, `no-misused-promises`, `await-thenable`, `no-explicit-any`.

`no-console`, which here is not generic hygiene: `console.log` writes to stdout, and in server mode stdout is the JSON-RPC channel. ADR §4 goes from a paragraph to an executable rule.

`no-floating-promises` needs `allowForKnownSafeCalls` pointing at `node:test`. Without the option there are 75 false positives, all from `test()` returning a promise nobody should await. With it, zero.

The whole `recommendedTypeChecked` preset stays out. It brought nine more errors for free (`unbound-method` in tests, `require-await` in the rate limiter) that nobody chose and that would wreck the calibration.

## The core boundary

> Withdrawn — see the amendment at the top of this document. The rule now lives in `.dependency-cruiser.js`.

A `files: ["src/core/**"]` block with `no-restricted-imports` barring `pluggy/`, `storage/`, `mcp/` and `pluggy-sdk`.

This closes ADR §179's open question without `eslint-plugin-import`. The ADR expected enforcement to cost a third devDependency; it costs nothing.

## The ceiling on loosening

ESLint imposes no limit on an inline override. Verified: `/* eslint complexity: ["warn", 12] */` silences the rule and ESLint does not complain.

Two local rules, defined as an inline plugin inside `eslint.config.js` itself, with no new dependency.

`local/complexity-ceiling` reads the file's comments and fails any directive raising complexity above 7. Raising it to 7 passes; 12 fails, with a message saying that past this the answer is to refactor.

`local/require-disable-reason` fails an `eslint-disable` with no `-- reason`. It is what keeps the article's escape valve honest: suppress, yes; suppress silently, no.

`// eslint-disable-next-line complexity -- reason` stays valid. Keeping the valve the way the article draws it was an explicit decision.

## The formatter

`tools/eslint-formatter-agent.js`. ESLint's contract is a function taking results and returning a string, so no dependency is involved.

It groups by rule, not by file. That inversion is the point: the agent reads "complexity blew up in three places, here is what to do about complexity" instead of three files with one cryptic line each.

The guidance text lives in a `rule → string` map at the top of the file. A rule with no entry falls back to ESLint's own message, so adding a rule never breaks the formatter.

The article reports that cyclomatic complexity kept climbing until refactoring guidance made it into the message. That finding is what justifies the formatter existing instead of accepting the default output.

Output goes to stdout. That is correct: `npm run lint` is a separate process from the MCP server.

## Gate

A warning never fails. An error fails. That is the article's reading: a sensor for self-correction, not a cancel button.

CI now runs `typecheck → lint → test → build`.

## Logging

A `Logger` contract in `core/contracts.ts`, in the same pattern as the existing `Clock` and `Bank`. Core declares the interface it needs; pino is built in `bin/cata-centavo.ts` and passed down by parameter. `core/` never imports pino, so ADR §6's import rule still stands and the test uses `tests/fakes/fake-logger.ts`, which accumulates lines in an array.

**Destination.** `pino.destination({ dest: 2, sync: true })`. Pino's default is fd 1, which is exactly the channel ADR §4 forbids; this is not a preference, it is mandatory. The `sync` avoids losing a line on `process.exitCode`.

**File.** `XDG_STATE_HOME/cata-centavo/cata-centavo.log`, with `~/Library/Logs/cata-centavo/` on darwin. The XDG spec names logs as its example of what belongs in state: it persists across runs, but is not important or portable enough for `XDG_DATA_HOME`. Cache would be wrong because it disappears; data would be wrong because ADR §10 says that file is never deleted.

It enters as a third root in the existing `resolvePaths`, following the same darwin mapping as the other two.

Mode `0600`. ADR §788 records that the Go implementation left the log at `0666` with a live bearer token inside it.

**Stderr and file at once** via `pino.multistream`, which is part of pino's core.

**Rotation** with `pino-roll`, cutting at 5 MB. It costs `date-fns` in the tree and takes runtime dependencies to five. An explicit decision, against the alternative of rolling our own at boot, because a homegrown one would only cut between runs and an MCP server running for days would blow past the limit without ever cutting.

**Redaction** on the credential fields, with a censor. Together with `0600` it is belt and braces, and both are needed: redaction only protects a field somebody remembered to list.

**`base: undefined`**, no `pid` and no `hostname` on every line of a local CLI.

**Levels.** Default `warn` on stderr and `info` in the file. `CATA_CENTAVO_LOG_LEVEL` raises both, `CATA_CENTAVO_LOG_FILE=off` turns the file off. In server mode stderr vanishes inside the MCP client, so the file is the only diagnostic surface left, and `doctor` prints its path.

**`say()` stays separate.** `init` and `doctor` write a report for a human; turning it into NDJSON makes it worse. Pino is the diagnostic channel, `say()` is the UI. Both on stderr, distinct roles.

## Dependency cost

CLAUDE.md asks for the devDependencies list to stay at two entries unless there is a decision. This is the decision.

devDependencies goes from 2 to 4: `@types/node`, `eslint`, `typescript`, `typescript-eslint`.

dependencies goes from 3 to 5: `@modelcontextprotocol/sdk`, `pluggy-sdk`, `zod`, `pino`, `pino-roll`.

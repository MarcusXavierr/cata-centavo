# Coverage reports as a sensor

## Decision

Use Node 24's built-in test coverage. `npm run coverage` will run the complete test suite, print the usual test results and per-file coverage table, and write `coverage/lcov.info`. CI will run the same command after the ordinary test step.

Coverage stays a sensor. There are no line, branch, or function thresholds, so a low score cannot fail CI. A failed test or a failure to generate the report still fails because that means the sensor itself is broken.

## Why this shape

Three approaches fit the project:

1. **Native summary and LCOV:** zero dependencies, useful output for an agent in the terminal, and a standard machine-readable artifact. This is the selected approach.
2. **Native summary only:** simpler, but leaves no report for editors or later analysis.
3. **`c8`:** richer formats and mature filtering, at the cost of another development dependency for features Node 24 already provides.

The report includes `src/**/*.ts`, even when a source file was never loaded by a test. Test files remain excluded. This avoids the most misleading coverage result: a high percentage calculated only from files the suite happened to touch.

## Commands and CI

An npm lifecycle hook creates `coverage/` with Node's filesystem API, which works across supported platforms. The coverage command uses two built-in reporters:

- `spec` writes test results and the coverage table to stdout.
- `lcov` writes `coverage/lcov.info`.

CI keeps `npm test` as the fast regression gate and runs `npm run coverage` after it. This repeats the suite deliberately: the first command answers whether behavior passes, while the second produces the maintainability sensor. The existing `coverage/` ignore rule keeps generated data out of Git.

## Verification

An automated configuration test locks down the command, source inclusion, LCOV destination, lack of thresholds, and CI wiring. Final validation follows the repository order: typecheck, lint, dependency rules, tests, coverage, then build.

# Coverage Reports Implementation Plan

**Goal:** Add non-blocking source coverage reports for local use and CI.

**Architecture:** Use Node 24's test coverage and reporters directly. Keep the sensor separate from `npm test`, write LCOV under the already-ignored `coverage/` directory, and configure no thresholds.

**Tech Stack:** Node.js 24 test runner, npm scripts, GitHub Actions

---

### Task 1: Lock down the coverage contract

**Files:**
- Create: `tests/tools/coverage-config.test.ts`

- [ ] Add a test that reads `package.json` and `.github/workflows/ci.yml`.
- [ ] Assert that coverage includes all `src/**/*.ts`, prints `spec` output, writes LCOV, contains no coverage thresholds, and runs in CI.
- [ ] Run `node --test tests/tools/coverage-config.test.ts` and confirm it fails because the scripts do not exist.

### Task 2: Add the native coverage command

**Files:**
- Modify: `package.json`

- [ ] Add `precoverage` to create `coverage/` with `node:fs`.
- [ ] Add `coverage` with Node's native coverage, `spec`, and `lcov` reporters.
- [ ] Run the focused configuration test and confirm it passes.
- [ ] Run `npm run coverage` and inspect both the terminal table and `coverage/lcov.info`.

### Task 3: Run the sensor in CI

**Files:**
- Modify: `.github/workflows/ci.yml`

- [ ] Add `npm run coverage` after `npm test`.
- [ ] Run the focused configuration test and confirm it passes.

### Task 4: Validate the complete change

- [ ] Run `npm run typecheck`.
- [ ] Run `npm run lint`.
- [ ] Run `npm run deps`.
- [ ] Run `npm test`.
- [ ] Run `npm run coverage`.
- [ ] Run `npm run build`.
- [ ] Check `git diff --check` and review the scoped diff without disturbing unrelated mutation-testing work.

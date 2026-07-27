# Dependency rules implementation plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enforce the ADR's layering with `dependency-cruiser`, reporting violations in a format an agent can act on.

**Architecture:** Eight named `forbidden` rules in `.dependency-cruiser.js`, each carrying its own guidance in its `comment` field. A custom reporter groups violations by rule and prints each rule's guidance once, mirroring `tools/eslint-formatter-agent.js`. The `src/core/**` block leaves `eslint.config.js`, so architecture lives in one place.

**Tech Stack:** dependency-cruiser 18.1, Node 24.15, `node:test`, ESLint 10.8.

**Design:** `docs/plans/2026-07-26-dependency-rules-design.md`. Read it first.

---

## Before anything

**Run `nvm use`.** This machine defaults to Node 18 and the failure is misleading: one test file dies with `ERR_UNKNOWN_FILE_EXTENSION` while `npm test` reports `# tests 0` and exits 0.

**Commits:** CLAUDE.md says do not commit unless asked. The commit steps below are in the plan because TDD wants frequent cut points, but confirm with Marcus before the first one.

**Validation order, always:** `npm run typecheck` → `npm run lint` → `npm test`.

**Heads up on the working tree.** As of writing, `src/pluggy/` is mid-refactor by another session — `client.ts`, `errors.ts`, `transport.ts` and their tests are uncommitted and moving. None of this plan touches those files, but if `npm test` fails in `tests/pluggy/`, that is not your change. Check `git status` before assuming you broke something.

---

## Task 1: Install dependency-cruiser

**Files:**
- Modify: `package.json` (`devDependencies`, `scripts`)

**Step 1: Install**

```bash
nvm use && npm install -D dependency-cruiser@^18.1.0
```

It may already be present from a `--no-save` bench run. Installing again is harmless and writes it into `package.json` and the lockfile, which is the point.

**Step 2: Confirm the binary**

```bash
npx depcruise --version
```

Expected: `18.1.0` or later.

**Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "build: add dependency-cruiser"
```

---

## Task 2: A minimal config that finds the known cycle

This is the red step. The cycle is real and already in the tree; the config is correct when it reports it.

**Files:**
- Create: `.dependency-cruiser.js`

**Step 1: Write the config**

The project is `"type": "module"`, so this file is ESM and uses `export default`. Verified: `depcruise` auto-detects `.dependency-cruiser.js` and parses it as ESM, so `--config` is not needed on the command line.

```js
/**
 * Architecture rules as a sensor. Each rule carries its own guidance in
 * `comment`, which is what `tools/depcruise-reporter-agent.js` prints and what
 * the native `err-long` reporter prints for a human. One source of truth.
 *
 * See "Sensors for coding agents" (Martin Fowler, 2026) and the design document
 * at docs/plans/2026-07-26-dependency-rules-design.md.
 */
export default {
  forbidden: [
    {
      name: "no-cycles",
      severity: "error",
      comment: `A cycle welds both ends together: neither module can be read, tested or
replaced without the other. Move the shared declaration into the module
that genuinely owns it, so one direction survives and the other dies.`,
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },

    /**
     * Mandatory, and the reason is not obvious. With this off, `import type`
     * edges vanish and `src/core/contracts.ts` becomes an orphan: every one of
     * its importers uses `import type`. The file the ADR leans on to justify
     * the architecture would be reported as dead code.
     */
    tsPreCompilationDeps: true,

    tsConfig: { fileName: "tsconfig.json" },

    /** `.ts` first is what makes `from "./wire.ts"` resolve. */
    enhancedResolveOptions: {
      extensions: [".ts", ".js", ".mjs", ".json"],
      conditionNames: ["import", "node", "default"],
    },
  },
};
```

**Step 2: Run it and see the violation**

```bash
npx depcruise src tests
```

Expected: exactly one error.

```
  error no-cycles: src/storage/db.ts →
      src/storage/migrations.ts →
      src/storage/db.ts

x 1 dependency violations (1 errors, 0 warnings). 45 modules, 103 dependencies cruised.
```

A different module or dependency count is fine — the tree is moving. A *different violation*, or none, means something changed since the design was written. Stop and report rather than adjusting the config to match.

**Step 3: Do not commit yet.** The config lands green in Task 4.

---

## Task 3: Break the cycle

**Files:**
- Modify: `src/storage/db.ts` (remove the `Migration` type, import it instead)
- Modify: `src/storage/migrations.ts` (declare `Migration`, drop the import from `db.ts`)

**Step 1: Move the type**

`Migration` describes a migration, not a database. It sits in `db.ts` by accident.

In `src/storage/migrations.ts`, delete the first line:

```ts
import type { Migration } from "./db.ts";
```

and declare the type there instead, keeping its existing docblock if it has one:

```ts
export type Migration = {
  // ...exactly the shape currently in db.ts:13
};
```

In `src/storage/db.ts`, delete the `export type Migration = { ... }` block and add the type to the import that already exists:

```ts
import { CACHE_MIGRATIONS, DATA_MIGRATIONS, type Migration } from "./migrations.ts";
```

Inline `type` on the specifier, not a separate `import type` line — `verbatimModuleSyntax` is on, and the value import is already there.

**Step 2: Check for other importers**

```bash
grep -rn "Migration" src tests --include='*.ts'
```

Anything importing `Migration` from `../storage/db.ts` needs its import path updated. `db.ts:48`, `db.ts:125` and `db.ts:134` use the type internally and only need the import above.

**Step 3: Verify**

```bash
npm run typecheck && npm test && npx depcruise src tests
```

Expected: typecheck clean, tests pass, and `✔ no dependency violations found`.

**Step 4: Commit**

```bash
git add src/storage/db.ts src/storage/migrations.ts
git commit -m "refactor: move the Migration type to the module that owns it"
```

---

## Task 4: The full rule set

**Files:**
- Modify: `.dependency-cruiser.js`

**Step 1: Add the seven remaining rules**

Keep `no-cycles` where it is and add these to the `forbidden` array. Guidance text goes in `comment` — that is the whole discovery surface an agent gets, so write it as an instruction, not as a label.

```js
    {
      name: "core-imports-no-infrastructure",
      severity: "error",
      comment: `src/core/ holds business rules and imports no infrastructure (ADR §6).
The contract belongs to its consumer: declare what you need as a type in
core/contracts.ts and receive the implementation as a parameter.`,
      from: { path: "^src/core/" },
      to: { path: "^src/(pluggy|storage|mcp)/" },
    },
    {
      name: "core-imports-no-packages",
      severity: "error",
      comment: `src/core/ is pure. No SDK, no client, no driver — only zod, which the ADR
already promises to core/category.ts. If you need what a package does, put
the type in core/contracts.ts and let bin/ inject the implementation.`,
      from: { path: "^src/core/" },
      to: { dependencyTypes: ["npm"], pathNot: "node_modules/zod/" },
    },
    {
      name: "only-bin-builds-infrastructure",
      severity: "error",
      comment: `Only src/bin/ constructs infrastructure. cli/ and mcp/ receive Bank, Store
and Logger as parameters, which is what keeps init and doctor testable and
what lets ADR §16.4 forbid process.exit inside a provider.`,
      from: { path: "^src/(cli|mcp)/" },
      to: { path: "^src/(pluggy|storage)/|^src/logging\\.ts$" },
    },
    {
      name: "src-imports-no-tests",
      severity: "error",
      comment: `Production code reaching into tests/. The fakes live outside src/ precisely
so this cannot happen — if you need this shape in production, it is not a
fake, it is a missing abstraction.`,
      from: { path: "^src/" },
      to: { path: "^tests/" },
    },
    {
      name: "no-dev-dependencies-in-src",
      severity: "error",
      comment: `A devDependency imported from src/ ships broken: it is absent from the
published package. Move it to dependencies, or move the code that needs it
out of src/.`,
      from: { path: "^src/" },
      to: { dependencyTypes: ["npm-dev"] },
    },
    {
      name: "no-undeclared-folders",
      severity: "error",
      comment: `A module under src/ outside the folders the ADR lists. No services/, no
utils/, no ports/ or adapters/ — the pattern lives in the direction of
dependencies, not in a folder name. Amend the ADR before adding a folder.`,
      from: {},
      to: {
        path: "^src/",
        pathNot: "^src/(bin|cli|core|mcp|pluggy|storage)/|^src/(config|logging)\\.ts$",
      },
    },
    {
      name: "no-orphans",
      severity: "warn",
      comment: `Nothing imports this module and it imports nothing. Usually dead code left
behind by a refactor. If it is a new module nobody has wired up yet, this
warning disappears the moment something imports it.`,
      from: { orphan: true, pathNot: "\\.d\\.ts$" },
      to: {},
    },
```

**Step 2: Run and expect clean**

```bash
npx depcruise src tests
```

Expected: `✔ no dependency violations found`.

If `no-orphans` fires, read what it names before silencing it. A test file that imports nothing is a real finding. A `.d.ts` is already excluded.

If `no-undeclared-folders` fires on something legitimate, the ADR list needs amending, not the regex.

**Step 3: Prove each rule actually bites**

A rule that never fires is indistinguishable from a rule with a typo in its regex. Verify each one once, by hand, then delete the probe. This is the same discipline CLAUDE.md asks for when it says every tool parameter needs a test proving it reaches the request.

```bash
# core-imports-no-infrastructure + core-imports-no-packages
printf 'import "../storage/db.ts";\nimport "pino";\n' > src/core/probe.ts
npx depcruise src tests | grep -E "core-imports-no-(infrastructure|packages)"
rm src/core/probe.ts

# only-bin-builds-infrastructure
printf 'import "../pluggy/client.ts";\n' > src/cli/probe.ts
npx depcruise src tests | grep only-bin-builds-infrastructure
rm src/cli/probe.ts

# src-imports-no-tests
printf 'import "../../tests/fakes/fixed-clock.ts";\n' > src/core/probe.ts
npx depcruise src tests | grep src-imports-no-tests
rm src/core/probe.ts

# no-dev-dependencies-in-src
printf 'import "typescript";\n' > src/core/probe.ts
npx depcruise src tests | grep no-dev-dependencies-in-src
rm src/core/probe.ts

# no-undeclared-folders
mkdir -p src/utils && printf 'export const x = 1;\n' > src/utils/probe.ts
printf 'import "../utils/probe.ts";\n' > src/core/probe.ts
npx depcruise src tests | grep no-undeclared-folders
rm -r src/utils src/core/probe.ts
```

Each `grep` must print a line. A silent grep means that rule is dead — fix it before moving on.

`src/core/probe.ts` does not trip `no-undeclared-folders`, because `src/core/` is a declared folder. It does trip `core-imports-*` in every probe that lives there, so expect extra violations alongside the one you are grepping for.

**Step 4: Confirm clean again**

```bash
npx depcruise src tests
```

Expected: `✔ no dependency violations found`. Any probe left behind shows up here.

**Step 5: Commit**

```bash
git add .dependency-cruiser.js
git commit -m "feat: enforce the ADR layering with dependency rules"
```

---

## Task 5: The reporter

**Files:**
- Create: `tools/depcruise-reporter-agent.js`
- Create: `tools/depcruise-reporter-agent.d.ts`
- Test: `tests/tools/depcruise-reporter-agent.test.ts`

The native `err-long` prints each rule's `comment` once **per violation**. Measured: ten violations of one rule produced ten copies of the same paragraph. Grouping is the whole reason this file exists.

**Step 1: Write the failing test**

`tests/` is typechecked, so a `.js` file in `tools/` needs a sibling `.d.ts` — follow `tools/eslint-local-rules.d.ts`. Write the test first anyway; it fails on the missing module either way.

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import reporter from "../../tools/depcruise-reporter-agent.js";

/** The shape dependency-cruiser hands a reporter, trimmed to what we read. */
function cruiseResult(violations: unknown[], forbidden: unknown[]) {
  return {
    summary: {
      violations,
      error: violations.filter((v) => (v as { rule: { severity: string } }).rule.severity === "error").length,
      warn: violations.filter((v) => (v as { rule: { severity: string } }).rule.severity === "warn").length,
      ruleSetUsed: { forbidden },
      totalCruised: 45,
      totalDependenciesCruised: 103,
    },
  };
}

const CYCLE_RULE = { name: "no-cycles", severity: "error", comment: "Move the shared declaration." };
const BOUNDARY_RULE = { name: "core-imports-no-infrastructure", severity: "error", comment: "Declare it in contracts.ts." };

describe("depcruise-reporter-agent", () => {
  it("says nothing and exits 0 when there are no violations", () => {
    const { output, exitCode } = reporter(cruiseResult([], [CYCLE_RULE]));

    assert.equal(output, "");
    assert.equal(exitCode, 0);
  });

  it("prints a rule's guidance once no matter how many times it fired", () => {
    const { output } = reporter(
      cruiseResult(
        [
          { type: "dependency", from: "src/core/a.ts", to: "src/storage/db.ts", rule: BOUNDARY_RULE },
          { type: "dependency", from: "src/core/b.ts", to: "src/pluggy/client.ts", rule: BOUNDARY_RULE },
          { type: "dependency", from: "src/core/c.ts", to: "src/mcp/server.ts", rule: BOUNDARY_RULE },
        ],
        [BOUNDARY_RULE],
      ),
    );

    assert.equal(output.split("Declare it in contracts.ts.").length - 1, 1);
    assert.match(output, /core-imports-no-infrastructure · 3 occurrences · error/);
  });

  it("renders a cycle as a path rather than a pair", () => {
    const { output } = reporter(
      cruiseResult(
        [
          {
            type: "cycle",
            from: "src/storage/db.ts",
            to: "src/storage/migrations.ts",
            rule: CYCLE_RULE,
            cycle: [{ name: "src/storage/migrations.ts" }, { name: "src/storage/db.ts" }],
          },
        ],
        [CYCLE_RULE],
      ),
    );

    assert.match(output, /src\/storage\/db\.ts → src\/storage\/migrations\.ts → src\/storage\/db\.ts/);
  });

  it("exits non-zero on an error and zero on a warning alone", () => {
    const warnRule = { name: "no-orphans", severity: "warn", comment: "Probably dead code." };

    const failing = reporter(
      cruiseResult([{ type: "dependency", from: "a", to: "b", rule: CYCLE_RULE }], [CYCLE_RULE]),
    );
    const passing = reporter(
      cruiseResult([{ type: "module", from: "src/orphan.ts", to: "src/orphan.ts", rule: warnRule }], [warnRule]),
    );

    assert.equal(failing.exitCode, 1);
    assert.equal(passing.exitCode, 0);
  });

  it("counts errors and warnings separately in the footer", () => {
    const warnRule = { name: "no-orphans", severity: "warn", comment: "Probably dead code." };
    const { output } = reporter(
      cruiseResult(
        [
          { type: "dependency", from: "a", to: "b", rule: CYCLE_RULE },
          { type: "module", from: "src/orphan.ts", to: "src/orphan.ts", rule: warnRule },
        ],
        [CYCLE_RULE, warnRule],
      ),
    );

    assert.match(output, /1 error \(fails the build\), 1 warning \(does not\)\./);
  });

  it("falls back to the rule name when a rule carries no comment", () => {
    const bare = { name: "no-comment-here", severity: "error" };
    const { output } = reporter(
      cruiseResult([{ type: "dependency", from: "a", to: "b", rule: bare }], [bare]),
    );

    assert.match(output, /no-comment-here/);
  });
});
```

**Step 2: Run it and watch it fail**

```bash
nvm use && node --test tests/tools/depcruise-reporter-agent.test.ts
```

Expected: failure, `Cannot find module '../../tools/depcruise-reporter-agent.js'`.

**Step 3: Implement**

Create `tools/depcruise-reporter-agent.js`. Match the house style of `tools/eslint-formatter-agent.js` — same `name · N occurrences · severity` header, same two-space indent on guidance, same blank-line rhythm.

Requirements the tests pin down:

- Group violations by `rule.name`, errors before warnings.
- Read the guidance from `summary.ruleSetUsed.forbidden[]`, matched by name. A rule with no `comment` renders its violations and no guidance paragraph — never a crash.
- A `cycle` violation renders `from → ...cycle[].name` joined by `→`. Every other type renders `from → to`. An orphan arrives as `type: "module"` with `from === to`; render it as the single path.
- `exitCode` is `summary.error`, so warnings never fail the build.
- Return `""` and `exitCode` 0 when there are no violations.
- Footer pluralises: `1 error (fails the build), 1 warning (does not).` and `2 errors (fail the build), 0 warnings (do not).`

Then create `tools/depcruise-reporter-agent.d.ts`:

```ts
export type ReporterOutput = {
  readonly output: string;
  readonly exitCode: number;
};

declare function reporter(cruiseResult: unknown): ReporterOutput;

export default reporter;
```

`unknown` rather than dependency-cruiser's own `ICruiseResult`: importing the type would put a devDependency in the typecheck path of `tests/`, and the test builds the shape by hand anyway.

**Step 4: Run and watch it pass**

```bash
npm run typecheck && node --test tests/tools/depcruise-reporter-agent.test.ts
```

Expected: `pass 6`, `fail 0`.

**Step 5: Commit**

```bash
git add tools/depcruise-reporter-agent.js tools/depcruise-reporter-agent.d.ts tests/tools/depcruise-reporter-agent.test.ts
git commit -m "feat: add agent-oriented dependency-cruiser reporter"
```

---

## Task 6: Wire the reporter in

**Files:**
- Modify: `package.json` (`scripts`)

**Step 1: Add the script**

```jsonc
"deps": "depcruise src tests --output-type plugin:./tools/depcruise-reporter-agent.js",
"prepublishOnly": "npm run typecheck && npm run lint && npm run deps && npm test"
```

No `--config`: `.dependency-cruiser.js` is auto-detected.

**Step 2: Run it on a real violation**

```bash
printf 'import "../storage/db.ts";\n' > src/core/probe.ts
npm run deps
rm src/core/probe.ts
```

Expected: the grouped format, one guidance paragraph, and a non-zero exit. Confirm the exit code separately, because `npm run` masks it in the output:

```bash
printf 'import "../storage/db.ts";\n' > src/core/probe.ts
npm run deps > /dev/null 2>&1; echo "exit=$?"
rm src/core/probe.ts
```

Expected: `exit=1`.

**Step 3: Run it clean**

```bash
npm run deps; echo "exit=$?"
```

Expected: no output from the reporter, `exit=0`.

**Step 4: Commit**

```bash
git add package.json
git commit -m "build: add npm run deps"
```

---

## Task 7: Remove the core boundary from ESLint

The rule now lives in one place. Two configs expressing the same constraint in two syntaxes will diverge, and the day they diverge nobody notices.

**Files:**
- Modify: `eslint.config.js` (delete the `files: ["src/core/**/*.ts"]` block)

**Step 1: Delete the block**

Remove this entirely:

```js
  {
    files: ["src/core/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: ["**/pluggy/**", "**/storage/**", "**/mcp/**", "pluggy-sdk"] },
      ],
    },
  },
```

`no-restricted-imports` is already gone from the `GUIDANCE` map in `tools/eslint-formatter-agent.js`. Confirm it stayed gone:

```bash
grep -n "no-restricted-imports" eslint.config.js tools/eslint-formatter-agent.js
```

Expected: no output.

**Step 2: Prove the coverage did not drop**

The point of this task is that nothing gets weaker. Same probe, now caught by the other tool:

```bash
printf 'import "../storage/db.ts";\n' > src/core/probe.ts
npm run lint  | grep -c no-restricted-imports   # expect 0 — eslint no longer cares
npm run deps  | grep -c core-imports-no-infrastructure   # expect at least 1
rm src/core/probe.ts
```

**Step 3: Full chain**

```bash
npm run typecheck && npm run lint && npm run deps && npm test && npm run build
```

**Step 4: Commit**

```bash
git add eslint.config.js
git commit -m "refactor: move the core boundary out of eslint"
```

---

## Task 8: CI and CLAUDE.md

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `CLAUDE.md`

**Step 1: CI**

In `.github/workflows/ci.yml`, between the lint step and the test step:

```yaml
      # Architecture rules. Unlike lint, these fail the build: a broken layer is
      # not a style opinion. See docs/plans/2026-07-26-dependency-rules-design.md.
      - run: npm run deps
```

**Step 2: CLAUDE.md**

In the Commands block, after `npm run lint`:

```
npm run deps             # dependency-cruiser — architecture rules, errors fail
```

In "Code quality process", change the order to `typecheck → lint → deps → test → build`, which is what CI now runs.

In the Architecture section, replace the sentence "This is currently convention, not enforcement — no tooling checks it." It is enforcement now. Say where it lives:

```
`.dependency-cruiser.js` enforces this, along with the cycle, orphan and
composition-root rules that only exist in the graph.
```

**Step 3: Validate the whole chain one more time**

```bash
nvm use && npm run typecheck && npm run lint && npm run deps && npm test && npm run build
```

Expected: typecheck clean, lint with warnings and exit 0, deps silent and exit 0, all tests passing, build clean.

**Step 4: Commit**

```bash
git add .github/workflows/ci.yml CLAUDE.md
git commit -m "build: run dependency rules in CI"
```

---

## Execution notes

**If the cycle in Task 2 does not appear.** Someone already moved `Migration`. Skip Task 3 and say so; do not invent a different violation to prove the config works.

**If a probe file survives a failed command.** `rm` after a non-zero exit still runs in the sequences above because they are separate statements, but check `git status` between tasks. A leftover `src/core/probe.ts` will make every later step lie.

**If `no-orphans` fires on a test file.** Read it before excluding it. A `.test.ts` that imports nothing is either dead or a test that forgot to import its subject.

**If dependency counts differ from the numbers here.** Expected — `src/pluggy/` is being refactored in parallel. Counts are context, not assertions. Rule names are the assertions.

**On adding a ninth rule.** Guidance goes in `comment`, not in the reporter. The reporter has no rule-specific knowledge and adding a rule must never require touching it.

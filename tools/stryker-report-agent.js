/**
 * Turns Stryker's JSON report into something worth reading.
 *
 * Same inversion as `eslint-formatter-agent.js`, for the same reason: grouping
 * by mutator instead of by file means the reader sees "eleven branches flip
 * without a test noticing, here is what to do about a branch" rather than
 * eleven files with one cryptic line each. See "Sensors for coding agents"
 * (Martin Fowler, 2026) and docs/plans/2026-07-26-mutation-testing-design.md.
 *
 * The raw report is a few hundred kilobytes and must never reach an agent's
 * context. That is the whole job of this file.
 *
 * A mutator missing from GUIDANCE still renders, so a Stryker upgrade that adds
 * one never breaks this script.
 */

import { readFileSync } from "node:fs";

const REPORT = "reports/mutation/mutation.json";

/** Detected. The test suite noticed. */
const DETECTED = new Set(["Killed", "Timeout"]);

/** Undetected. The mutant lived, which is what this report is about. */
const UNDETECTED = new Set(["Survived", "NoCoverage"]);

/**
 * Neither. The mutant never ran, so it says nothing about the tests — counting
 * these would move the score for a reason that has nothing to do with test
 * quality.
 */
const INVALID = new Set(["CompileError", "RuntimeError", "Ignored", "Pending"]);

const GUIDANCE = {
  ConditionalExpression: `A branch was forced always-true or always-false and no test noticed.
Either the false path is never exercised, or both paths are exercised
and nothing asserts the difference between them.

Write the case for the branch that is missing. If both paths genuinely
produce the same observable result, the condition is dead code — delete
it rather than testing it.`,

  EqualityOperator: `A comparison was loosened or tightened (=== to !==, < to <=) and the
suite stayed green. This is the boundary nobody asserts.

\`classify()\` in src/pluggy/errors.ts is the shape to watch: a status
code that no test names will let its comparison mutate freely.`,

  ArithmeticOperator: `An operator flipped (+ to -, * to /) with every test still passing.
The value is computed but never asserted.

The backoff in src/core/refresh.ts is the case to check first —
asserting how many times it slept does not assert how long it slept.`,

  BlockStatement: `An entire function body was emptied and the suite did not notice. The
function is called but its effect is never checked.

This is ADR §16's shipped bug exactly: "a declared tool parameter that
never reaches the wire" — parsed, validated, assigned, never read. If a
body can vanish silently, nothing proves it runs.`,

  StringLiteral: `A string was blanked and nothing failed.

Make the judgment. In src/pluggy/errors.ts the message is the product —
ADR §16.4 requires a model to recover from these, so assert them with
\`assert.match\`. In a log line or a human-facing report it is noise, and
the right answer is to suppress it:
  // Stryker disable next-line StringLiteral: log text, not behaviour`,

  LogicalOperator: `&& became || (or the reverse) with no test noticing. One operand is
carrying the whole condition; the other is never what decides.

Write the case where the two operands disagree.`,

  ObjectLiteral: `An object literal was emptied and nothing failed. Its properties are
built but never read by any assertion — the shape is assumed, not
checked. \`assert.deepEqual\` on the whole object closes this.`,

  Regex: `A pattern was loosened (\\s+ to \\s, a group made non-optional) and the
suite stayed green. The regex is only ever tested against inputs that
the loosened version also matches.

Add the input that distinguishes them, especially the one that must
*not* match.`,

  OptionalChaining: `\`?.\` became \`.\` and nothing failed — the null path is never taken in
any test. \`item.parameter?.label ?? null\` in src/pluggy/mapper.ts is
the shape: absence needs its own case, because ADR §10 makes absence
mean NULL rather than empty string.`,

  ArrayDeclaration: `An array was emptied or filled and no assertion moved. Its contents are
never checked, only its existence.`,

  ArrowFunction: `An arrow function body was replaced with \`undefined\` and nothing
failed. The callback is passed but its return value is never what a
test depends on.`,

  MethodExpression: `A method call was swapped or removed with the suite still green — the
call's effect on the result is never asserted.`,

  UnaryOperator: `A sign or negation flipped without a test noticing.`,

  UpdateOperator: `++ became -- (or the reverse) and nothing failed. A counter or index is
advanced but never asserted, which in a pagination loop is how
aggregates get computed over a fraction of the data (ADR §16.3).`,

  BooleanLiteral: `A boolean was inverted and no test noticed. The flag is set but never
what a test depends on.`,

  AssignmentOperator: `A compound assignment changed meaning and nothing failed. The variable
is written but its value is never asserted.`,
};

/** `Survived` and `NoCoverage` read differently and the fix differs too. */
const STATUS_NOTE = { NoCoverage: " (no coverage)", Survived: "" };

function statusesOf(report) {
  return Object.entries(report.files ?? {}).flatMap(([file, entry]) =>
    (entry.mutants ?? []).map((mutant) => ({ file, mutant })),
  );
}

function round(value) {
  return Math.round(value * 100) / 100;
}

/**
 * Stryker's own arithmetic: detected over everything viable. `scoreCovered`
 * drops the mutants no test reaches, which is why both are reported — a high
 * covered score next to a low total score means the gap is untested code, not
 * weak assertions.
 */
export function summarize(report) {
  const all = statusesOf(report).map(({ mutant }) => mutant.status);
  const count = (set) => all.filter((status) => set.has(status)).length;

  const killed = all.filter((status) => status === "Killed").length;
  const timeout = all.filter((status) => status === "Timeout").length;
  const survived = all.filter((status) => status === "Survived").length;
  const noCoverage = all.filter((status) => status === "NoCoverage").length;

  const detected = count(DETECTED);
  const viable = detected + count(UNDETECTED);
  const covered = detected + survived;

  return {
    killed,
    timeout,
    survived,
    noCoverage,
    invalid: count(INVALID),
    detected,
    viable,
    score: viable === 0 ? null : round((detected / viable) * 100),
    scoreCovered: covered === 0 ? null : round((detected / covered) * 100),
  };
}

export function groupByMutator(report) {
  const groups = new Map();

  for (const { file, mutant } of statusesOf(report)) {
    if (!UNDETECTED.has(mutant.status)) continue;

    const group = groups.get(mutant.mutatorName) ?? { mutator: mutant.mutatorName, entries: [] };
    group.entries.push({
      where: `${file}:${mutant.location.start.line}:${mutant.location.start.column}`,
      what: `${mutant.mutatorName} → ${oneLine(mutant.replacement)}${STATUS_NOTE[mutant.status] ?? ""}`,
    });
    groups.set(mutant.mutatorName, group);
  }

  for (const group of groups.values()) {
    group.entries.sort((a, b) => a.where.localeCompare(b.where, "en", { numeric: true }));
  }

  return [...groups.values()].sort((a, b) => b.entries.length - a.entries.length);
}

export function hotspots(report) {
  const counts = new Map();

  for (const { file, mutant } of statusesOf(report)) {
    if (!UNDETECTED.has(mutant.status)) continue;
    counts.set(file, (counts.get(file) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([file, undetected]) => ({ file, undetected }))
    .sort((a, b) => b.undetected - a.undetected);
}

function oneLine(replacement) {
  const flat = String(replacement).replace(/\s+/g, " ").trim();

  return flat.length > 60 ? `${flat.slice(0, 57)}...` : flat;
}

function renderGroup(group) {
  const header = `${group.mutator} · ${group.entries.length} undetected`;
  const width = Math.max(...group.entries.map((entry) => entry.where.length));
  const lines = group.entries.map((entry) => `  ${entry.where.padEnd(width)}  ${entry.what}`);
  const guidance = GUIDANCE[group.mutator];

  const indented = guidance === undefined ? [] : ["", guidance.replace(/^(?=.)/gm, "  ")];

  return [header, "", ...lines, ...indented, ""].join("\n");
}

function renderHotspots(ranked) {
  const width = Math.max(...ranked.map((spot) => spot.file.length));

  return [
    "Hotspots",
    "",
    ...ranked.map((spot) => `  ${spot.file.padEnd(width)}  ${spot.undetected}`),
    "",
  ].join("\n");
}

export function render(report) {
  const summary = summarize(report);
  const groups = groupByMutator(report);

  const score =
    summary.score === null
      ? "No viable mutants — check the `mutate` globs."
      : `Score ${summary.score}% overall, ${summary.scoreCovered}% of covered code ` +
        `(${summary.detected} detected of ${summary.viable} viable).`;

  if (groups.length === 0) {
    return ["", score, "No surviving mutants. Every viable mutation was caught.", ""].join("\n");
  }

  const footer =
    `${score}\n` +
    `${summary.survived} survived, ${summary.noCoverage} never covered` +
    `${summary.invalid === 0 ? "" : `, ${summary.invalid} not viable`}. ` +
    `This sensor never fails the build.`;

  return ["", ...groups.map(renderGroup), renderHotspots(hotspots(report)), footer, ""].join("\n");
}

function main() {
  let raw;

  try {
    raw = readFileSync(REPORT, "utf8");
  } catch {
    process.stderr.write(`No report at ${REPORT}. Run \`npm run mutation\` first.\n`);
    process.exitCode = 1;
    return;
  }

  process.stdout.write(render(JSON.parse(raw)));
}

if (process.argv[1]?.endsWith("stryker-report-agent.js")) {
  main();
}

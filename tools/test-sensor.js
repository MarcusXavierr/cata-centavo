/**
 * `node --test` as a sensor.
 *
 * The sidecar ships parsers for vitest and pytest, neither of which this project
 * uses (ADR §7). The `default` parser reads the first JSON object on stdout, so
 * wrapping the native runner costs one file instead of a dependency.
 *
 * Two conditions this reports that a bare `npm test` cannot, both of them the
 * same failure CLAUDE.md opens with: on Node 18 the suite prints `# tests 0` and
 * exits 0. A background daemon inherits whatever PATH started it, so a green run
 * that executed nothing is the likeliest way this sensor could lie.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** The version this project runs on, read from the one place that declares it. */
export function requiredNodeMajor() {
  return Number(readFileSync(".nvmrc", "utf8").trim().replace(/^v/, "").split(".")[0]);
}

function counters(line) {
  return /^# (tests|pass|fail) (\d+)$/.exec(line);
}

function failure(line) {
  return /^(\s*)not ok \d+ - (.+?)(?:\s+# .*)?$/.exec(line);
}

/**
 * A depth-0 `not ok` naming the file itself is the runner reporting that the
 * file as a whole failed. It is worth keeping only when no test inside it
 * reported, which is what happens when the file dies on import.
 */
function withoutFileEchoes(failures) {
  const filesWithNamedFailures = new Set(
    failures.filter((entry) => entry.name !== entry.file).map((entry) => entry.file),
  );

  return failures
    .filter((entry) => entry.name !== entry.file || !filesWithNamedFailures.has(entry.file))
    .map(({ file, name }) => ({ file, name }));
}

export function parseTap(text) {
  const counts = { tests: 0, pass: 0, fail: 0 };
  const failures = [];
  let file = null;

  for (const line of text.split("\n")) {
    const subtest = /^# Subtest: (.+)$/.exec(line);
    if (subtest !== null) {
      file = subtest[1];
      continue;
    }

    const count = counters(line);
    if (count !== null) {
      counts[count[1]] = Number(count[2]);
      continue;
    }

    const failed = failure(line);
    if (failed !== null) failures.push({ file, name: failed[2].trim() });
  }

  return { ...counts, failures: withoutFileEchoes(failures) };
}

function versionFinding(nodeMajor) {
  return {
    message:
      `Node v${nodeMajor} cannot strip types: the suite reports "# tests 0" and exits 0, ` +
      `which reads as green. Run \`nvm use\` in the shell that starts the sidecar.`,
    severity: "error",
    rule: "node-version",
  };
}

function emptyFinding() {
  return {
    message: "The runner found no tests. A suite that never ran proves nothing.",
    severity: "error",
    rule: "no-tests",
  };
}

export function reading({ nodeMajor, tap }) {
  const parsed = parseTap(tap);

  const findings = [];
  if (nodeMajor < requiredNodeMajor()) findings.push(versionFinding(nodeMajor));
  else if (parsed.tests === 0) findings.push(emptyFinding());

  findings.push(
    ...parsed.failures.map((entry) => ({
      message: entry.name,
      severity: "error",
      file: entry.file,
      rule: "test-failure",
    })),
  );

  return {
    success: findings.length === 0,
    summary:
      findings.length === 0
        ? `${parsed.pass} passing`
        : `${parsed.fail} failing of ${parsed.tests}`,
    score: { value: parsed.fail, direction: "less", description: "Failing tests" },
    metrics: [
      { key: "tests", label: "tests", value: parsed.tests, direction: "more" },
      { key: "pass", label: "passing", value: parsed.pass, direction: "more" },
      { key: "fail", label: "failing", value: parsed.fail, direction: "less" },
    ],
    findings,
  };
}

function main() {
  const run = spawnSync(process.execPath, ["--test", "--test-reporter=tap"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });

  const major = Number(process.versions.node.split(".")[0]);
  process.stdout.write(JSON.stringify(reading({ nodeMajor: major, tap: run.stdout ?? "" })));
}

if (process.argv[1]?.endsWith("test-sensor.js")) {
  main();
}

/**
 * Node's LCOV output as a sensor.
 *
 * The sidecar's coverage parsers read vitest's JSON, which this project does not
 * produce (ADR §7). LCOV is a line-oriented format from 2002 and parsing the six
 * records that matter is cheaper than the alternative.
 *
 * This sensor never reports failure. `docs/plans/2026-07-26-coverage-reports.md`
 * set no thresholds on purpose: coverage says which lines the suite never
 * reached, and mutation testing says whether the reached ones are asserted. Only
 * the second is worth gating on, and it does not gate either.
 *
 * The findings are a ranking, not a threshold — the files that still have
 * uncovered lines, worst first. On a fully covered tree there are none.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const REPORT = "coverage/lcov.info";

/** How many under-covered files reach the agent. The tail is rarely news. */
const LISTED = 5;

const RECORDS = {
  LF: ["lines", "found"],
  LH: ["lines", "hit"],
  BRF: ["branches", "found"],
  BRH: ["branches", "hit"],
  FNF: ["functions", "found"],
  FNH: ["functions", "hit"],
};

function emptyCounts() {
  return {
    lines: { found: 0, hit: 0 },
    branches: { found: 0, hit: 0 },
    functions: { found: 0, hit: 0 },
  };
}

export function percent({ found, hit }) {
  return found === 0 ? 0 : Math.round((hit / found) * 1000) / 10;
}

export function parseLcov(text) {
  const files = [];
  const totals = emptyCounts();
  let current = null;

  for (const line of text.split("\n")) {
    const [key, value] = line.split(":");

    if (key === "SF") {
      current = { file: value, ...emptyCounts() };
      files.push(current);
      continue;
    }

    const record = RECORDS[key ?? ""];
    if (record === undefined || current === null) continue;

    const [kind, side] = record;
    current[kind][side] += Number(value);
    totals[kind][side] += Number(value);
  }

  return { files, totals };
}

function uncovered(files) {
  return files
    .filter((entry) => entry.lines.hit < entry.lines.found)
    .sort((left, right) => percent(left.lines) - percent(right.lines))
    .slice(0, LISTED)
    .map((entry) => ({
      message: `${percent(entry.lines)}% of lines covered (${entry.lines.hit} of ${entry.lines.found}).`,
      severity: "info",
      file: entry.file,
      rule: "uncovered-lines",
    }));
}

function metric(key, counts) {
  return { key, label: key, value: percent(counts), direction: "more" };
}

export function reading(lcov) {
  const { files, totals } = parseLcov(lcov);
  const lines = percent(totals.lines);

  return {
    success: true,
    summary:
      totals.lines.found === 0
        ? "No coverage data — did the run produce a report?"
        : `${lines}% of lines, ${percent(totals.branches)}% of branches`,
    // Rounded, because the sidecar types a score as an integer and rejects the
    // whole reading otherwise. It only surfaced once coverage stopped landing on
    // a whole number by luck. The tenth survives in the metrics below, which are
    // typed as floats.
    score: { value: Math.round(lines), direction: "more", description: "Line coverage" },
    metrics: [
      metric("lines", totals.lines),
      metric("branches", totals.branches),
      metric("functions", totals.functions),
    ],
    findings: uncovered(files),
  };
}

function main() {
  spawnSync("npm", ["run", "-s", "coverage"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

  let lcov = "";
  try {
    lcov = readFileSync(REPORT, "utf8");
  } catch {
    lcov = "";
  }

  process.stdout.write(JSON.stringify(reading(lcov)));
}

if (process.argv[1]?.endsWith("coverage-sensor.js")) {
  main();
}

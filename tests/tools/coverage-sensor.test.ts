import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseLcov, reading } from "../../tools/coverage-sensor.js";

const LCOV = `TN:
SF:src/cli/dispatch.ts
FNF:3
FNH:3
BRF:20
BRH:18
LF:40
LH:40
end_of_record
TN:
SF:src/pluggy/transport.ts
FNF:10
FNH:6
BRF:30
BRH:15
LF:60
LH:30
end_of_record
`;

const PERFECT = `TN:
SF:src/cli/dispatch.ts
FNF:3
FNH:3
BRF:10
BRH:10
LF:20
LH:20
end_of_record
`;

describe("parseLcov", () => {
  it("reads one record per source file", () => {
    const parsed = parseLcov(LCOV);

    assert.deepEqual(
      parsed.files.map((entry) => entry.file),
      ["src/cli/dispatch.ts", "src/pluggy/transport.ts"],
    );
  });

  it("sums found and hit across records", () => {
    const parsed = parseLcov(LCOV);

    assert.deepEqual(parsed.totals.lines, { found: 100, hit: 70 });
    assert.deepEqual(parsed.totals.branches, { found: 50, hit: 33 });
    assert.deepEqual(parsed.totals.functions, { found: 13, hit: 9 });
  });

  it("survives an empty report rather than dividing by zero", () => {
    const parsed = parseLcov("");

    assert.deepEqual(parsed.files, []);
    assert.deepEqual(parsed.totals.lines, { found: 0, hit: 0 });
  });
});

describe("reading", () => {
  it("scores line coverage, higher being better", () => {
    const report = reading(LCOV);

    assert.equal(report.score.value, 70);
    assert.equal(report.score.direction, "more");
  });

  it("keeps the score a whole number, which is all the sidecar's schema accepts", () => {
    const awkward = `TN:
SF:src/a.ts
LF:9
LH:8
BRF:3
BRH:1
FNF:1
FNH:1
end_of_record
`;

    const report = reading(awkward);

    assert.equal(Number.isInteger(report.score.value), true);
    assert.equal(report.score.value, 89);
    assert.equal(report.metrics[0]?.value, 88.9);
  });

  it("never fails, because this sensor reports and does not gate", () => {
    assert.equal(reading(LCOV).success, true);
    assert.equal(reading("").success, true);
  });

  it("carries line, branch and function coverage as metrics", () => {
    const keys = reading(LCOV).metrics.map((metric) => metric.key);

    assert.deepEqual(keys, ["lines", "branches", "functions"]);
  });

  it("names the files with uncovered lines, worst first", () => {
    const report = reading(LCOV);

    assert.equal(report.findings.length, 1);
    assert.equal(report.findings[0]?.file, "src/pluggy/transport.ts");
    assert.equal(report.findings[0]?.severity, "info");
    assert.match(report.findings[0]?.message ?? "", /30 of 60/);
  });

  it("says nothing when every line is covered", () => {
    const report = reading(PERFECT);

    assert.deepEqual(report.findings, []);
    assert.equal(report.score.value, 100);
  });

  it("reports zero rather than NaN when there is nothing to cover", () => {
    const report = reading("");

    assert.equal(report.score.value, 0);
    assert.match(report.summary, /no coverage data/i);
  });
});

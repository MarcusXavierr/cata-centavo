import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseTap, reading, requiredNodeMajor } from "../../tools/test-sensor.js";

const GREEN = `TAP version 13
# Subtest: tests/core/refresh.test.ts
    # Subtest: retries on a transient failure
    ok 1 - retries on a transient failure
    1..1
ok 1 - tests/core/refresh.test.ts
1..1
# tests 1
# suites 1
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 42
`;

const RED = `TAP version 13
# Subtest: tests/pluggy/client.test.ts
    # Subtest: paginates to totalPages
    not ok 1 - paginates to totalPages
      ---
      error: 'Expected values to be strictly equal'
      ...
    1..1
not ok 1 - tests/pluggy/client.test.ts
1..1
# tests 1
# suites 1
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 42
`;

const CRASHED = `TAP version 13
# Subtest: tests/storage/db.test.ts
not ok 1 - tests/storage/db.test.ts
  ---
  error: "Cannot find module './missing.ts'"
  ...
1..1
# tests 1
# suites 0
# pass 0
# fail 1
# duration_ms 12
`;

const EMPTY = `TAP version 13
1..0
# tests 0
# suites 0
# pass 0
# fail 0
# duration_ms 3
`;

describe("parseTap", () => {
  it("reads the counters off the summary block", () => {
    const parsed = parseTap(GREEN);

    assert.equal(parsed.tests, 1);
    assert.equal(parsed.pass, 1);
    assert.equal(parsed.fail, 0);
    assert.deepEqual(parsed.failures, []);
  });

  it("names the failing test and the file it lives in", () => {
    const parsed = parseTap(RED);

    assert.equal(parsed.fail, 1);
    assert.deepEqual(parsed.failures, [
      { file: "tests/pluggy/client.test.ts", name: "paginates to totalPages" },
    ]);
  });

  it("keeps the file-level failure when a file dies before any test runs", () => {
    const parsed = parseTap(CRASHED);

    assert.deepEqual(parsed.failures, [
      { file: "tests/storage/db.test.ts", name: "tests/storage/db.test.ts" },
    ]);
  });
});

describe("reading", () => {
  it("succeeds on a green run", () => {
    const report = reading({ nodeMajor: requiredNodeMajor(), tap: GREEN });

    assert.equal(report.success, true);
    assert.equal(report.findings.length, 0);
    assert.equal(report.score.value, 0);
    assert.equal(report.score.direction, "less");
  });

  it("turns each failing test into a finding", () => {
    const report = reading({ nodeMajor: requiredNodeMajor(), tap: RED });

    assert.equal(report.success, false);
    assert.equal(report.score.value, 1);
    assert.equal(report.findings[0]?.file, "tests/pluggy/client.test.ts");
    assert.match(report.findings[0]?.message ?? "", /paginates to totalPages/);
  });

  it("fails on a run that executed nothing, however green it looks", () => {
    const report = reading({ nodeMajor: requiredNodeMajor(), tap: EMPTY });

    assert.equal(report.success, false);
    assert.match(report.findings[0]?.message ?? "", /no tests/i);
  });

  it("refuses to report success under a Node too old to strip types", () => {
    const report = reading({ nodeMajor: 18, tap: GREEN });

    assert.equal(report.success, false);
    assert.match(report.findings[0]?.message ?? "", /nvm use/);
    assert.equal(report.findings[0]?.rule, "node-version");
  });

  it("carries the counters as metrics so the sidecar can trend them", () => {
    const report = reading({ nodeMajor: requiredNodeMajor(), tap: GREEN });
    const keys = report.metrics.map((metric) => metric.key);

    assert.deepEqual(keys, ["tests", "pass", "fail"]);
  });
});

describe("requiredNodeMajor", () => {
  it("reads the major from .nvmrc rather than hardcoding it", () => {
    assert.equal(requiredNodeMajor(), 24);
  });
});

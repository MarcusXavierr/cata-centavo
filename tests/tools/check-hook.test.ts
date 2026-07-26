import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

const HOOK = ".sensors/check-hook.sh";

/**
 * A `sensors` that reports what the test wants it to report. The hook exists to
 * translate its exit codes, so the real binary would only add latency.
 */
function withStubbedSensors(exitCode: number | null, input = "{}", output = "types: FAILURE") {
  const bin = mkdtempSync(join(tmpdir(), "sensors-stub-"));

  const stub = join(bin, "sensors");

  if (exitCode !== null) {
    // The shebang matters: .sensors/cli.sh uses it to tell the sidecar apart
    // from the lm_sensors binary of the same name.
    writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' '${output}'\nexit ${exitCode}\n`);
    chmodSync(stub, 0o755);
  }

  return spawnSync("bash", [HOOK], {
    encoding: "utf8",
    input,
    env: { PATH: "/usr/bin:/bin", SENSORS_BIN: stub, CLAUDE_PROJECT_DIR: process.cwd() },
  });
}

describe("check-hook", () => {
  it("stays out of the way when every sensor passes", () => {
    const run = withStubbedSensors(0);

    assert.equal(run.status, 0);
    assert.equal(run.stderr, "");
  });

  it("blocks and hands the report back when a sensor fails", () => {
    const run = withStubbedSensors(1);

    assert.equal(run.status, 2);
    assert.match(run.stderr, /types: FAILURE/);
  });

  it("blocks on a score that fell below its threshold", () => {
    const run = withStubbedSensors(3);

    assert.equal(run.status, 2);
  });

  it("says nothing when the sidecar is not running", () => {
    const run = withStubbedSensors(2, "{}", "No runner state found.");

    assert.equal(run.status, 0);
    assert.equal(run.stderr, "");
  });

  it("says nothing when sensors is not installed at all", () => {
    const run = withStubbedSensors(null);

    assert.equal(run.status, 0);
    assert.equal(run.stderr, "");
  });

  it("gives up rather than looping when it already blocked once", () => {
    const run = withStubbedSensors(1, '{"stop_hook_active": true}');

    assert.equal(run.status, 0);
  });

  it("ignores the lm_sensors binary Fedora puts on PATH under the same name", () => {
    const run = spawnSync("bash", [HOOK], {
      encoding: "utf8",
      input: "{}",
      env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent", CLAUDE_PROJECT_DIR: process.cwd() },
    });

    assert.equal(run.status, 0);
    assert.equal(run.stderr, "");
  });
});

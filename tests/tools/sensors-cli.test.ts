import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

const CLI = ".sensors/cli.sh";

/** The uv-installed entry point: a Python console script, so it has a shebang. */
function realSensors(dir: string, name = "sensors") {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\necho "sensors got: $*"\nexit 0\n`);
  chmodSync(path, 0o755);

  return path;
}

/**
 * lm_sensors: an ELF binary that answers `check` with a parse error. The two
 * leading bytes are what tells them apart without paying for a process.
 */
function lmSensors(dir: string) {
  const path = join(dir, "sensors");
  writeFileSync(path, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]));
  chmodSync(path, 0o755);

  return path;
}

function run(env: Record<string, string>, args: string[] = ["check", "."]) {
  return spawnSync("bash", [CLI, ...args], { encoding: "utf8", env });
}

describe("sensors cli resolver", () => {
  it("forwards its arguments to the real binary", () => {
    const home = mkdtempSync(join(tmpdir(), "sensors-home-"));
    realSensors(home);

    const result = run({ PATH: "/usr/bin:/bin", SENSORS_BIN: join(home, "sensors") });

    assert.equal(result.status, 0);
    assert.match(result.stdout, /sensors got: check \./);
  });

  it("prefers the uv install over anything on PATH", () => {
    const uv = mkdtempSync(join(tmpdir(), "sensors-uv-"));
    const path = mkdtempSync(join(tmpdir(), "sensors-path-"));
    realSensors(uv);
    lmSensors(path);

    const result = run({ PATH: `${path}:/usr/bin:/bin`, SENSORS_BIN: join(uv, "sensors") });

    assert.equal(result.status, 0);
    assert.match(result.stdout, /sensors got/);
  });

  it("skips the ELF impostor and keeps walking PATH", () => {
    const impostor = mkdtempSync(join(tmpdir(), "sensors-lm-"));
    const genuine = mkdtempSync(join(tmpdir(), "sensors-ok-"));
    lmSensors(impostor);
    realSensors(genuine);

    const result = run({ PATH: `${impostor}:${genuine}:/usr/bin:/bin`, HOME: "/nonexistent" });

    assert.equal(result.status, 0);
    assert.match(result.stdout, /sensors got/);
  });

  it("exits 127 with an explanation when only the impostor is there", () => {
    const impostor = mkdtempSync(join(tmpdir(), "sensors-lm-only-"));
    lmSensors(impostor);

    const result = run({ PATH: `${impostor}:/usr/bin:/bin`, HOME: "/nonexistent" });

    assert.equal(result.status, 127);
    assert.match(result.stderr, /uv tool install/);
    assert.match(result.stderr, /lm_sensors/);
  });

  it("passes the real binary's exit code straight through", () => {
    const home = mkdtempSync(join(tmpdir(), "sensors-exit-"));
    const path = join(home, "sensors");
    writeFileSync(path, "#!/bin/sh\nexit 3\n");
    chmodSync(path, 0o755);

    assert.equal(run({ PATH: "/usr/bin:/bin", SENSORS_BIN: path }).status, 3);
  });
});

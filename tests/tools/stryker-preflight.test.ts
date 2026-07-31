import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { ignored, render, scan } from "../../tools/stryker-preflight.js";

describe("ignored", () => {
  const cases: [path: string, patterns: string[], expected: boolean][] = [
    [".sensors/cata-centavo.sock", ["**/*.sock"], true],
    ["cata-centavo.sock", ["**/*.sock"], true],
    ["a/b/c/deep.sock", ["**/*.sock"], true],
    ["wait_finish_task_5_7", ["**/*.sock"], false],
    ["node_modules/pluggy-sdk/x.sock", [], true],
    [".git/hooks/pipe", [], true],
    [".stryker-tmp/sandbox-abc/pipe", [], true],
    ["reports/mutation/pipe", [], true],
    ["src/reports/pipe", [], false],
    ["dist/pipe", ["dist"], true],
    ["docs/adr/pipe", ["docs"], true],
    ["src/core/aggregate.ts", ["dist", "docs"], false],
  ];

  function verb(expected: boolean) {
    if (expected) return "ignores";
    return "keeps";
  }

  for (const [path, patterns, expected] of cases) {
    it(`${verb(expected)} ${path} under [${patterns.join(", ")}]`, () => {
      assert.equal(ignored(path, patterns), expected);
    });
  }

  it("never lets a negation mark a path ignored, because that path is copied", () => {
    assert.equal(ignored("keep.sock", ["**/*.sock", "!keep.sock"]), true);
    assert.equal(ignored("keep.sock", ["!keep.sock"]), false);
  });
});

describe("render", () => {
  it("names every offender", () => {
    const message = render(["wait_finish_task_5_7", "tests/x.pipe"]);

    assert.match(message, /wait_finish_task_5_7/);
    assert.match(message, /tests\/x\.pipe/);
  });

  it("says what to do about it", () => {
    assert.match(render(["pipe"]), /ignorePatterns|delete/i);
  });
});

describe("scan", () => {
  const root = mkdtempSync(join(tmpdir(), "preflight-"));

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns the FIFOs Stryker would block on, and nothing else", async () => {
    writeFileSync(join(root, "regular.ts"), "");
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "reports"));
    execFileSync("mkfifo", [join(root, "src", "buried")]);
    execFileSync("mkfifo", [join(root, "reports", "ignored-by-default")]);
    execFileSync("mkfifo", [join(root, "loose.sock")]);

    assert.deepEqual(await scan(root, ["**/*.sock"]), ["src/buried"]);
  });

  it("follows a symlink to a FIFO, which Stryker copies by target", async () => {
    const target = join(root, "target");
    execFileSync("mkfifo", [target]);
    symlinkSync(target, join(root, "link"));

    assert.deepEqual(await scan(root, ["target", "**/*.sock"]), ["link", "src/buried"]);
  });
});

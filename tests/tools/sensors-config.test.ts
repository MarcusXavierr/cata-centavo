import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const CONFIG = ".sensors/cata-centavo.sensors.yaml";

type Runner = {
  name: string;
  parser?: string;
  mode?: string;
  command?: string;
  interval?: number;
  result?: string;
};

/**
 * A reader for the flat `key: value` runner list this project writes, not a YAML
 * parser. The alternative is a devDependency, and ADR §5 prices those in written
 * decisions rather than convenience.
 */
function runners(yaml: string): Runner[] {
  return yaml
    .split(/^\s*- name:/m)
    .slice(1)
    .map((block) => {
      const entry: Runner = { name: block.split("\n")[0]?.trim() ?? "" };

      for (const line of block.split("\n").slice(1)) {
        const match = /^\s{4}(\w+):\s*(.+?)\s*$/.exec(line);
        if (match === null) continue;

        const [, key, value] = match as unknown as [string, keyof Runner, string];
        if (key === "interval") entry.interval = Number(value);
        else if (key !== "name") entry[key] = value;
      }

      return entry;
    });
}

const NAMES = ["tests", "lint", "types", "structure", "cov", "security", "mutation", "mut_state"];

describe("sensors sidecar configuration", () => {
  it("declares every sensor this project owns", async () => {
    const parsed = runners(await readFile(CONFIG, "utf8"));

    assert.deepEqual(
      parsed.map((runner) => runner.name),
      NAMES,
    );
  });

  it("names only npm scripts that exist", async () => {
    const parsed = runners(await readFile(CONFIG, "utf8"));
    const scripts = (
      JSON.parse(await readFile("package.json", "utf8")) as { scripts: Record<string, string> }
    ).scripts;

    const referenced = parsed.flatMap((runner) => [...(runner.command ?? "").matchAll(/npm run (?:-s )?(\S+)/g)]);

    assert.ok(referenced.length > 0);
    for (const [, script] of referenced) assert.ok(script !== undefined && script in scripts, script);
  });

  it("staggers the intervals so two sensors never fire together", async () => {
    const intervals = runners(await readFile(CONFIG, "utf8"))
      .map((runner) => runner.interval)
      .filter((interval) => interval !== undefined);

    assert.equal(new Set(intervals).size, intervals.length);
  });

  it("gives every interval runner an interval and no other runner one", async () => {
    for (const runner of runners(await readFile(CONFIG, "utf8"))) {
      const scheduled = runner.mode === "interval";
      assert.equal(runner.interval !== undefined, scheduled, runner.name);
    }
  });

  it("declares a parser for everything except the on_check runner", async () => {
    for (const runner of runners(await readFile(CONFIG, "utf8"))) {
      assert.equal(runner.parser !== undefined, runner.mode !== "on_check", runner.name);
    }
  });

  it("routes every Node command through the version guard", async () => {
    const parsed = runners(await readFile(CONFIG, "utf8"));

    for (const runner of parsed) {
      const command = runner.command ?? "";
      if (!/\b(npm|npx|node)\b/.test(command)) continue;

      assert.match(command, /^\.sensors\/node\.sh /, runner.name);
    }
  });

  it("reads the mutation report from the path Stryker writes it to", async () => {
    const parsed = runners(await readFile(CONFIG, "utf8"));
    const stryker = JSON.parse(await readFile("stryker.config.json", "utf8")) as {
      jsonReporter: { fileName: string };
    };

    const mutation = parsed.find((runner) => runner.name === "mutation");

    assert.equal(mutation?.result, stryker.jsonReporter.fileName);
  });

  it("feeds ESLint through the JSON formatter, not the one written for a terminal", async () => {
    const scripts = (
      JSON.parse(await readFile("package.json", "utf8")) as { scripts: Record<string, string> }
    ).scripts;

    assert.match(scripts["lint:sensor"] ?? "", /eslint-formatter-sensor\.js/);
    assert.match(scripts["lint"] ?? "", /eslint-formatter-agent\.js/);
  });

  it("never invokes a bare `sensors`, which on Fedora is the hardware monitor", async () => {
    const scripts = await Promise.all(
      [".sensors/check-hook.sh", "CLAUDE.md"].map((path) => readFile(path, "utf8")),
    );

    for (const text of scripts) {
      for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("#") || line.includes("lm_sensors")) continue;
        assert.doesNotMatch(line, /(?<![/\w.])sensors (check|start|stop|status|snapshot)\b/);
      }
    }
  });

  it("keeps the sidecar's runtime state out of git", async () => {
    const ignored = await readFile(".sensors/.gitignore", "utf8");

    for (const pattern of ["*.jsonl", "*.log", "*.state.json", "*.control.json", "*.sock"]) {
      assert.ok(ignored.includes(pattern), pattern);
    }
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import sensorFormatter from "../../tools/eslint-formatter-sensor.js";
import { GUIDANCE } from "../../tools/eslint-guidance.js";

type Message = {
  ruleId: string | null;
  severity: number;
  message: string;
  line: number;
  column: number;
};

function result(filePath: string, messages: Message[]) {
  return {
    filePath,
    messages,
    errorCount: messages.filter((message) => message.severity === 2).length,
    warningCount: messages.filter((message) => message.severity === 1).length,
    source: "const x = 1;\n".repeat(400),
  };
}

const COMPLEXITY: Message = {
  ruleId: "complexity",
  severity: 1,
  message: "Arrow function has a complexity of 9.",
  line: 12,
  column: 3,
};

const CONSOLE: Message = {
  ruleId: "no-console",
  severity: 2,
  message: "Unexpected console statement.",
  line: 4,
  column: 1,
};

function parse(results: unknown[]) {
  return JSON.parse(sensorFormatter(results)) as {
    files: { filePath: string; errorCount: number; warningCount: number; messages: Message[] }[];
    summary: {
      totalErrors: number;
      totalWarnings: number;
      triggeredRules: { ruleId: string; guidance: string }[];
    };
  };
}

describe("eslint-formatter-sensor", () => {
  it("emits parseable JSON on a clean run", () => {
    const report = parse([result("/repo/src/a.ts", [])]);

    assert.deepEqual(report.files, []);
    assert.equal(report.summary.totalErrors, 0);
    assert.equal(report.summary.totalWarnings, 0);
    assert.deepEqual(report.summary.triggeredRules, []);
  });

  it("counts errors and warnings separately across files", () => {
    const report = parse([
      result("/repo/src/a.ts", [CONSOLE, COMPLEXITY]),
      result("/repo/src/b.ts", [COMPLEXITY]),
    ]);

    assert.equal(report.summary.totalErrors, 1);
    assert.equal(report.summary.totalWarnings, 2);
  });

  it("reports paths relative to the repository root", () => {
    const report = parse([result(`${process.cwd()}/src/a.ts`, [CONSOLE])]);

    assert.equal(report.files[0]?.filePath, "src/a.ts");
  });

  it("attaches each triggered rule's guidance exactly once", () => {
    const report = parse([
      result("/repo/src/a.ts", [COMPLEXITY]),
      result("/repo/src/b.ts", [COMPLEXITY]),
    ]);

    assert.equal(report.summary.triggeredRules.length, 1);
    assert.equal(report.summary.triggeredRules[0]?.ruleId, "complexity");
    assert.equal(report.summary.triggeredRules[0]?.guidance, GUIDANCE["complexity"]);
  });

  it("omits rules that have no guidance rather than emitting an empty body", () => {
    const unknown: Message = { ...COMPLEXITY, ruleId: "some/unmapped-rule" };
    const report = parse([result("/repo/src/a.ts", [unknown])]);

    assert.deepEqual(report.summary.triggeredRules, []);
    assert.equal(report.files[0]?.messages[0]?.ruleId, "some/unmapped-rule");
  });

  it("drops the source text, which is the bulk of an ESLint result", () => {
    const report = parse([result("/repo/src/a.ts", [CONSOLE])]);

    assert.equal(Object.hasOwn(report.files[0] ?? {}, "source"), false);
  });

  it("keeps files that reported nothing out of the payload", () => {
    const report = parse([result("/repo/src/a.ts", []), result("/repo/src/b.ts", [CONSOLE])]);

    assert.equal(report.files.length, 1);
    assert.equal(report.files[0]?.filePath, "/repo/src/b.ts");
  });
});

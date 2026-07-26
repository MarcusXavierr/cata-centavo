import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  groupByMutator,
  hotspots,
  render,
  renderSummary,
  summarize,
} from "../../tools/stryker-report-agent.js";

/** One mutant, with only the fields the reporter reads. */
function mutant(status: string, mutatorName: string, line = 1) {
  return {
    id: `${mutatorName}-${status}-${line}`,
    mutatorName,
    replacement: "false",
    status,
    location: { start: { line, column: 3 }, end: { line, column: 9 } },
  };
}

function report(files: Record<string, ReturnType<typeof mutant>[]>) {
  return {
    schemaVersion: "2.0",
    thresholds: { high: 80, low: 60 },
    files: Object.fromEntries(
      Object.entries(files).map(([path, mutants]) => [path, { language: "typescript", source: "", mutants }]),
    ),
  };
}

describe("summarize", () => {
  it("scores detected against every viable mutant, covered or not", () => {
    const summary = summarize(
      report({
        "src/a.ts": [
          mutant("Killed", "EqualityOperator"),
          mutant("Timeout", "ArithmeticOperator"),
          mutant("Survived", "BooleanLiteral"),
          mutant("NoCoverage", "BlockStatement"),
        ],
      }),
    );

    assert.equal(summary.killed, 1);
    assert.equal(summary.timeout, 1);
    assert.equal(summary.survived, 1);
    assert.equal(summary.noCoverage, 1);
    assert.equal(summary.viable, 4);
    assert.equal(summary.score, 50);
  });

  it("excludes the statuses that describe a broken mutant rather than a weak test", () => {
    const cases = ["Ignored", "CompileError", "RuntimeError"];

    for (const status of cases) {
      const summary = summarize(report({ "src/a.ts": [mutant("Killed", "X"), mutant(status, "Y")] }));

      assert.equal(summary.viable, 1, status);
      assert.equal(summary.score, 100, status);
    }
  });

  it("scores covered code separately, so no-coverage gaps cannot hide behind it", () => {
    const summary = summarize(
      report({
        "src/a.ts": [mutant("Killed", "X"), mutant("Survived", "Y"), mutant("NoCoverage", "Z")],
      }),
    );

    assert.equal(summary.score, 33.33);
    assert.equal(summary.scoreCovered, 50);
  });

  it("reports a score of null rather than dividing by zero on an empty report", () => {
    const summary = summarize(report({}));

    assert.equal(summary.viable, 0);
    assert.equal(summary.score, null);
  });
});

describe("groupByMutator", () => {
  it("groups the undetected across files, and ignores the killed", () => {
    const groups = groupByMutator(
      report({
        "src/a.ts": [mutant("Survived", "EqualityOperator", 4), mutant("Killed", "EqualityOperator", 5)],
        "src/b.ts": [mutant("NoCoverage", "EqualityOperator", 6), mutant("Survived", "BlockStatement", 7)],
      }),
    );

    assert.deepEqual(
      groups.map((group) => [group.mutator, group.entries.length]),
      [
        ["EqualityOperator", 2],
        ["BlockStatement", 1],
      ],
    );
    assert.equal(groups[0]?.entries[0]?.where, "src/a.ts:4:3");
  });

  it("orders by count so the widest gap is read first", () => {
    const groups = groupByMutator(
      report({
        "src/a.ts": [mutant("Survived", "Rare", 1), mutant("Survived", "Common", 2), mutant("Survived", "Common", 3)],
      }),
    );

    assert.deepEqual(
      groups.map((group) => group.mutator),
      ["Common", "Rare"],
    );
  });

  it("orders entries by line, not by the order Stryker happened to emit them", () => {
    const groups = groupByMutator(
      report({ "src/a.ts": [mutant("Survived", "X", 30), mutant("Survived", "X", 4), mutant("Survived", "X", 100)] }),
    );

    assert.deepEqual(
      groups[0]?.entries.map((entry) => entry.where),
      ["src/a.ts:4:3", "src/a.ts:30:3", "src/a.ts:100:3"],
    );
  });

  it("returns nothing when every mutant was killed", () => {
    assert.deepEqual(groupByMutator(report({ "src/a.ts": [mutant("Killed", "X")] })), []);
  });
});

describe("hotspots", () => {
  it("ranks files by how many mutants got away", () => {
    const ranked = hotspots(
      report({
        "src/quiet.ts": [mutant("Survived", "X", 1)],
        "src/loud.ts": [mutant("Survived", "X", 1), mutant("NoCoverage", "Y", 2)],
        "src/clean.ts": [mutant("Killed", "X", 1)],
      }),
    );

    assert.deepEqual(ranked, [
      { file: "src/loud.ts", undetected: 2 },
      { file: "src/quiet.ts", undetected: 1 },
    ]);
  });
});

describe("render", () => {
  it("states plainly that it fails nothing, so the reader does not treat it as a gate", () => {
    const output = render(report({ "src/a.ts": [mutant("Survived", "EqualityOperator")] }));

    assert.match(output, /never fails the build/i);
  });

  it("attaches guidance to a mutator it knows", () => {
    const output = render(report({ "src/a.ts": [mutant("Survived", "ArithmeticOperator")] }));

    assert.match(output, /ArithmeticOperator/);
    assert.match(output, /assert/i);
  });

  it("renders a mutator with no guidance entry rather than crashing", () => {
    const output = render(report({ "src/a.ts": [mutant("Survived", "SomeFutureMutator")] }));

    assert.match(output, /SomeFutureMutator/);
  });

  it("congratulates rather than printing an empty report when nothing survived", () => {
    const output = render(report({ "src/a.ts": [mutant("Killed", "X")] }));

    assert.match(output, /no surviving mutants/i);
  });
});

describe("renderSummary", () => {
  const SURVIVORS = report({
    "src/loud.ts": [mutant("Survived", "EqualityOperator", 1), mutant("NoCoverage", "BlockStatement", 2)],
    "src/quiet.ts": [mutant("Killed", "X", 1), mutant("Survived", "ArithmeticOperator", 2)],
  });

  it("keeps the score and the hotspots", () => {
    const output = renderSummary(SURVIVORS);

    assert.match(output, /Score 25%/);
    assert.match(output, /src\/loud\.ts/);
  });

  it("drops the per-mutant listing and the guidance, which is what makes it cheap", () => {
    const output = renderSummary(SURVIVORS);

    assert.doesNotMatch(output, /src\/loud\.ts:1:3/);
    assert.doesNotMatch(output, /EqualityOperator/);
    assert.ok(output.length < render(SURVIVORS).length);
  });

  it("points at the full report rather than pretending to be it", () => {
    assert.match(renderSummary(SURVIVORS), /npm run mutation:report/);
  });

  it("congratulates without a hotspot table when nothing survived", () => {
    const output = renderSummary(report({ "src/a.ts": [mutant("Killed", "X")] }));

    assert.match(output, /no surviving mutants/i);
    assert.doesNotMatch(output, /Hotspots/);
  });
});

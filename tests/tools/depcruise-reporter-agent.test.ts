import assert from "node:assert/strict";
import { describe, it } from "node:test";

import reporter from "../../tools/depcruise-reporter-agent.js";

function cruiseResult(violations: unknown[], forbidden: unknown[]) {
  return {
    summary: {
      violations,
      error: violations.filter((v) => (v as { rule: { severity: string } }).rule.severity === "error").length,
      warn: violations.filter((v) => (v as { rule: { severity: string } }).rule.severity === "warn").length,
      ruleSetUsed: { forbidden },
      totalCruised: 45,
      totalDependenciesCruised: 103,
    },
  };
}

const CYCLE_RULE = { name: "no-cycles", severity: "error", comment: "Move the shared declaration." };
const BOUNDARY_RULE = { name: "core-imports-no-infrastructure", severity: "error", comment: "Declare it in contracts.ts." };

describe("depcruise-reporter-agent", () => {
  it("says nothing and exits 0 when there are no violations", () => {
    const { output, exitCode } = reporter(cruiseResult([], [CYCLE_RULE]));

    assert.equal(output, "");
    assert.equal(exitCode, 0);
  });

  it("prints a rule's guidance once no matter how many times it fired", () => {
    const { output } = reporter(
      cruiseResult(
        [
          { type: "dependency", from: "src/core/a.ts", to: "src/storage/db.ts", rule: BOUNDARY_RULE },
          { type: "dependency", from: "src/core/b.ts", to: "src/pluggy/client.ts", rule: BOUNDARY_RULE },
          { type: "dependency", from: "src/core/c.ts", to: "src/mcp/server.ts", rule: BOUNDARY_RULE },
        ],
        [BOUNDARY_RULE],
      ),
    );

    assert.equal(output.split("Declare it in contracts.ts.").length - 1, 1);
    assert.match(output, /core-imports-no-infrastructure · 3 occurrences · error/);
  });

  it("renders a cycle as a path rather than a pair", () => {
    const { output } = reporter(
      cruiseResult(
        [
          {
            type: "cycle",
            from: "src/storage/db.ts",
            to: "src/storage/migrations.ts",
            rule: CYCLE_RULE,
            cycle: [{ name: "src/storage/migrations.ts" }, { name: "src/storage/db.ts" }],
          },
        ],
        [CYCLE_RULE],
      ),
    );

    assert.match(output, /src\/storage\/db\.ts → src\/storage\/migrations\.ts → src\/storage\/db\.ts/);
  });

  it("exits non-zero on an error and zero on a warning alone", () => {
    const warnRule = { name: "no-orphans", severity: "warn", comment: "Probably dead code." };

    const failing = reporter(
      cruiseResult([{ type: "dependency", from: "a", to: "b", rule: CYCLE_RULE }], [CYCLE_RULE]),
    );
    const passing = reporter(
      cruiseResult([{ type: "module", from: "src/orphan.ts", to: "src/orphan.ts", rule: warnRule }], [warnRule]),
    );

    assert.equal(failing.exitCode, 1);
    assert.equal(passing.exitCode, 0);
  });

  it("counts errors and warnings separately in the footer", () => {
    const warnRule = { name: "no-orphans", severity: "warn", comment: "Probably dead code." };
    const { output } = reporter(
      cruiseResult(
        [
          { type: "dependency", from: "a", to: "b", rule: CYCLE_RULE },
          { type: "module", from: "src/orphan.ts", to: "src/orphan.ts", rule: warnRule },
        ],
        [CYCLE_RULE, warnRule],
      ),
    );

    assert.match(output, /1 error \(fails the build\), 1 warning \(does not\)\./);
  });

  it("falls back to the rule name when a rule carries no comment", () => {
    const bare = { name: "no-comment-here", severity: "error" };
    const { output } = reporter(
      cruiseResult([{ type: "dependency", from: "a", to: "b", rule: bare }], [bare]),
    );

    assert.match(output, /no-comment-here/);
  });
});

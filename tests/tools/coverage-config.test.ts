import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

type PackageJson = {
  scripts?: Record<string, string>;
};

describe("coverage sensor configuration", () => {
  it("reports every source file to the terminal and LCOV without gating CI", async () => {
    const packageJson = JSON.parse(
      await readFile("package.json", "utf8"),
    ) as PackageJson;
    const ci = await readFile(".github/workflows/ci.yml", "utf8");
    const coverage = packageJson.scripts?.coverage ?? "";

    assert.match(packageJson.scripts?.precoverage ?? "", /mkdirSync\('coverage'/);
    assert.match(coverage, /--experimental-test-coverage/);
    assert.match(coverage, /--test-coverage-include="src\/\*\*\/\*\.ts"/);
    assert.match(coverage, /--test-reporter=spec/);
    assert.match(coverage, /--test-reporter-destination=stdout/);
    assert.match(coverage, /--test-reporter=lcov/);
    assert.match(
      coverage,
      /--test-reporter-destination=coverage\/lcov\.info/,
    );
    assert.doesNotMatch(coverage, /--test-coverage-(?:lines|branches|functions)=/);
    assert.match(ci, /- run: npm run coverage/);
  });
});

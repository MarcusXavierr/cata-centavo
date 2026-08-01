import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { MINIMUM_NODE, nodeVersionProblem } from "../../src/cli/node-version.ts";

const TOO_OLD = ["18.19.0", "20.11.1", "22.12.0", "22.5.0"];
const NEW_ENOUGH = ["22.13.0", "22.13.1", "22.14.0", "23.0.0", "24.15.0"];
const UNREADABLE = ["", "unknown", "v22"];

describe("nodeVersionProblem", () => {
  for (const version of TOO_OLD) {
    it(`reports Node ${version}`, () => {
      const problem = nodeVersionProblem(version);

      assert.notEqual(problem, null);
      assert.match(problem ?? "", new RegExp(version.replaceAll(".", "\\.")));
      assert.match(problem ?? "", new RegExp(MINIMUM_NODE.replaceAll(".", "\\.")));
    });
  }

  for (const version of NEW_ENOUGH) {
    it(`accepts Node ${version}`, () => {
      assert.equal(nodeVersionProblem(version), null);
    });
  }

  for (const version of UNREADABLE) {
    it(`lets Node "${version}" through rather than guessing`, () => {
      assert.equal(nodeVersionProblem(version), null);
    });
  }

  it("keeps MINIMUM_NODE in step with the engines field", () => {
    const raw = readFileSync(new URL("../../package.json", import.meta.url), "utf8");
    const pkg = JSON.parse(raw) as { engines: { node: string } };

    assert.equal(pkg.engines.node, `>=${MINIMUM_NODE}`);
  });
});

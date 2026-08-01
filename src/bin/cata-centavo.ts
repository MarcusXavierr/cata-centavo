#!/usr/bin/env node
/**
 * The version guard, and nothing else. `main.ts` is imported dynamically so
 * that its static `node:sqlite` dependency is resolved only after we know this
 * Node can resolve it — see src/cli/node-version.ts.
 */
import { nodeVersionProblem } from "../cli/node-version.ts";

const problem = nodeVersionProblem(process.versions.node);

if (problem === null) {
  await import("./main.ts");
} else {
  process.stderr.write(`${problem}\n`);
  process.exitCode = 1;
}

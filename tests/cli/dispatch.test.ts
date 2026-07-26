import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { COMMANDS, resolveInvocation } from "../../src/cli/dispatch.ts";

describe("resolveInvocation", () => {
  it("falls back to the MCP server when given no argument (ADR §4)", () => {
    assert.deepEqual(resolveInvocation([]), {
      kind: "command",
      command: COMMANDS.serve,
    });
  });

  it("recognizes every declared subcommand", () => {
    for (const command of Object.values(COMMANDS)) {
      assert.deepEqual(resolveInvocation([command]), { kind: "command", command });
    }
  });

  it("treats --help and -h as a help request", () => {
    assert.deepEqual(resolveInvocation(["--help"]), { kind: "help" });
    assert.deepEqual(resolveInvocation(["-h"]), { kind: "help" });
  });

  it("treats --version as a version request", () => {
    assert.deepEqual(resolveInvocation(["--version"]), { kind: "version" });
  });

  it("returns an unknown command as a value, not an exception", () => {
    const result = resolveInvocation(["migrate"]);
    assert.equal(result.kind, "error");

    let message = "";
    if (result.kind === "error") {
      message = result.message;
    }
    assert.match(message, /migrate/);
  });

  it("returns an unknown flag as a value, not an exception", () => {
    const result = resolveInvocation(["--yolo"]);
    assert.equal(result.kind, "error");
  });

  it("rejects a surplus positional argument", () => {
    const result = resolveInvocation(["doctor", "extra"]);
    assert.equal(result.kind, "error");

    let message = "";
    if (result.kind === "error") {
      message = result.message;
    }
    assert.match(message, /extra/);
  });
});

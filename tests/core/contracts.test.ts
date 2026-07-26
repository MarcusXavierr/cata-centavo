import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { fakeLogger } from "../fakes/fake-logger.ts";

describe("Logger", () => {
  it("records the fields and the message of every call", () => {
    const log = fakeLogger();

    log.info({ connectionId: "abc" }, "synced");

    assert.deepEqual(log.lines, [
      { level: "info", fields: { connectionId: "abc" }, message: "synced" },
    ]);
  });

  it("merges the bound fields of a child into every line it writes", () => {
    const log = fakeLogger();

    log.child({ connectionId: "abc" }).warn({ attempt: 2 }, "retrying");

    assert.deepEqual(log.lines, [
      { level: "warn", fields: { connectionId: "abc", attempt: 2 }, message: "retrying" },
    ]);
  });
});

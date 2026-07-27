import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { ClosingDayStore } from "../../../src/core/contracts.ts";
import type { ToolDeps } from "../../../src/mcp/tools/result.ts";
import {
  handleDeleteClosingDay,
  handleListClosingDays,
  handleSetClosingDay,
} from "../../../src/mcp/tools/closing-days.ts";
import { fakeLogger } from "../../fakes/fake-logger.ts";
import { fakeSource } from "../../fakes/fake-source.ts";

type StoreCall =
  | { readonly verb: "list" }
  | { readonly verb: "set"; readonly accountId: string; readonly day: number }
  | { readonly verb: "delete"; readonly accountId: string };

function fakeClosingDays(): { readonly store: ClosingDayStore; readonly calls: StoreCall[] } {
  const calls: StoreCall[] = [];
  return {
    calls,
    store: {
      list: () => {
        calls.push({ verb: "list" });
        return [{ accountId: "card-stored", day: 8 }];
      },
      set: (accountId, day) => {
        calls.push({ verb: "set", accountId, day });
      },
      delete: (accountId) => {
        calls.push({ verb: "delete", accountId });
        return 1;
      },
    },
  };
}

function depsWith(closingDays: ClosingDayStore): ToolDeps {
  const source = fakeSource();
  return {
    source,
    log: fakeLogger(),
    reader: source.reader,
    writer: source.writer,
    closingDays,
    clock: { now: () => new Date() },
  };
}

function payload(result: CallToolResult): unknown {
  const first = result.content[0];
  assert.ok(first !== undefined && first.type === "text");
  return JSON.parse(first.text);
}

const VERB_CASES: readonly {
  readonly name: string;
  readonly invoke: (deps: ToolDeps) => Promise<CallToolResult>;
  readonly expectedCall: StoreCall;
  readonly expectedPayload: unknown;
}[] = [
  {
    name: "listClosingDays calls list with no hidden filter",
    invoke: handleListClosingDays,
    expectedCall: { verb: "list" },
    expectedPayload: { closingDays: [{ accountId: "card-stored", day: 8 }] },
  },
  {
    name: "setClosingDay passes accountId and day to set",
    invoke: (deps) => handleSetClosingDay(deps, { accountId: "card-set", day: 12 }),
    expectedCall: { verb: "set", accountId: "card-set", day: 12 },
    expectedPayload: { accountId: "card-set", day: 12 },
  },
  {
    name: "deleteClosingDay passes accountId to delete",
    invoke: (deps) => handleDeleteClosingDay(deps, { accountId: "card-delete" }),
    expectedCall: { verb: "delete", accountId: "card-delete" },
    expectedPayload: { accountId: "card-delete", deleted: 1 },
  },
];

describe("closing-day tools", () => {
  for (const testCase of VERB_CASES) {
    it(testCase.name, async () => {
      const fixture = fakeClosingDays();

      const result = await testCase.invoke(depsWith(fixture.store));

      assert.deepEqual(fixture.calls, [testCase.expectedCall]);
      assert.deepEqual(payload(result), testCase.expectedPayload);
    });
  }

  for (const day of [0, 32, 1.5]) {
    it(`setClosingDay rejects invalid day ${day}`, async () => {
      const fixture = fakeClosingDays();

      const result = await handleSetClosingDay(depsWith(fixture.store), { accountId: "card-1", day });

      assert.equal(result.isError, true);
      assert.deepEqual(fixture.calls, []);
    });
  }
});

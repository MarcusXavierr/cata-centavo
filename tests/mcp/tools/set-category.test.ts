import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { CategoryWriter } from "../../../src/core/contracts.ts";
import { handleSetCategory, handleSetCounterpartyCategory } from "../../../src/mcp/tools/set-category.ts";
import { fakeLogger } from "../../fakes/fake-logger.ts";

function fakeWriter(overrides: Partial<CategoryWriter> = {}): CategoryWriter {
  return {
    setCategory: () => ({ updated: 1, unknownIds: [] }),
    setCounterpartyCategory: () => ({ affected: 5 }),
    ...overrides,
  };
}

function textOf(res: { readonly content: readonly { readonly type: string; readonly text?: string }[] }): string {
  const first = res.content[0];
  assert.ok(first !== undefined && first.type === "text" && first.text !== undefined);
  return first.text;
}

describe("setCategory tool", () => {
  it("refuses bad category ids", async () => {
    const deps = {
      source: { ok: true as const, connections: [], bank: {} as never, toFailure: () => ({ kind: "unavailable" as const, message: "" }), reader: {} as never, writer: fakeWriter() },
      log: fakeLogger(),
      reader: null,
      writer: fakeWriter(),
      clock: { now: () => new Date() },
    };

    const res = await handleSetCategory(deps, { transactionIds: ["t1"], category: "not-a-category" });
    assert.equal(res.isError, true);
    assert.match(textOf(res), /must be a known category id/i);
  });

  it("returns configuration problems when source is not ok", async () => {
    const deps = {
      source: { ok: false as const, problems: ["no config"] },
      log: fakeLogger(),
      reader: null,
      writer: null,
      clock: { now: () => new Date() },
    };

    const res = await handleSetCategory(deps, { transactionIds: ["t1"], category: "01000000" });
    assert.equal(res.isError, true);
    assert.match(textOf(res), /no config/);
  });

  it("calls writer.setCategory and returns JSON result", async () => {
    let calledWith: unknown = null;
    const writer = fakeWriter({
      setCategory: (ids, cat) => {
        calledWith = { ids, cat };
        return { updated: 2, unknownIds: ["t-unk"] };
      },
    });

    const deps = {
      source: { ok: true as const, connections: [], bank: {} as never, toFailure: () => ({ kind: "unavailable" as const, message: "" }), reader: {} as never, writer },
      log: fakeLogger(),
      reader: null,
      writer,
      clock: { now: () => new Date() },
    };

    const res = await handleSetCategory(deps, { transactionIds: ["t1", "t2", "t-unk"], category: "01000000" });
    assert.equal(res.isError, undefined);
    assert.deepEqual(calledWith, { ids: ["t1", "t2", "t-unk"], cat: "01000000" });
    assert.deepEqual(JSON.parse(textOf(res)), { updated: 2, unknownIds: ["t-unk"] });
  });
});

describe("setCounterpartyCategory tool", () => {
  it("refuses bad category ids", async () => {
    const deps = {
      source: { ok: true as const, connections: [], bank: {} as never, toFailure: () => ({ kind: "unavailable" as const, message: "" }), reader: {} as never, writer: fakeWriter() },
      log: fakeLogger(),
      reader: null,
      writer: fakeWriter(),
      clock: { now: () => new Date() },
    };

    const res = await handleSetCounterpartyCategory(deps, { document: "12345678000190", category: "bad-cat" });
    assert.equal(res.isError, true);
    assert.match(textOf(res), /must be a known category id/i);
  });

  it("refuses bad document strings", async () => {
    const deps = {
      source: { ok: true as const, connections: [], bank: {} as never, toFailure: () => ({ kind: "unavailable" as const, message: "" }), reader: {} as never, writer: fakeWriter() },
      log: fakeLogger(),
      reader: null,
      writer: fakeWriter(),
      clock: { now: () => new Date() },
    };

    const res = await handleSetCounterpartyCategory(deps, { document: "12345", category: "01000000" });
    assert.equal(res.isError, true);
    assert.match(textOf(res), /11-digit CPF or 14-digit CNPJ/i);
  });

  it("calls writer.setCounterpartyCategory and returns clean doc and affected count", async () => {
    let calledWith: unknown = null;
    const writer = fakeWriter({
      setCounterpartyCategory: (doc, cat) => {
        calledWith = { doc, cat };
        return { affected: 12 };
      },
    });

    const deps = {
      source: { ok: true as const, connections: [], bank: {} as never, toFailure: () => ({ kind: "unavailable" as const, message: "" }), reader: {} as never, writer },
      log: fakeLogger(),
      reader: null,
      writer,
      clock: { now: () => new Date() },
    };

    const res = await handleSetCounterpartyCategory(deps, { document: "12.345.678/0001-90", category: "02000000" });
    assert.equal(res.isError, undefined);
    assert.deepEqual(calledWith, { doc: "12345678000190", cat: "02000000" });
    assert.deepEqual(JSON.parse(textOf(res)), {
      document: "12345678000190",
      category: "02000000",
      affected: 12,
    });
  });
});


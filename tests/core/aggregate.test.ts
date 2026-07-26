import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { aggregate } from "../../src/core/aggregate.ts";
import { buildRollup } from "../../src/core/taxonomy.ts";
import type { CategoryId } from "../../src/core/category.ts";
import { tx } from "../fakes/transaction-builder.ts";

const ROLLUP: ReadonlyMap<string, CategoryId> = buildRollup([
  { id: "01000000", parentId: null },
  { id: "04000000", parentId: null },
  { id: "05000000", parentId: null },
  { id: "05020000", parentId: "05000000" },
  { id: "05100000", parentId: "05000000" },
  { id: "09000000", parentId: null },
  { id: "11000000", parentId: null },
  { id: "20000000", parentId: null },
  { id: "200100000", parentId: "20000000" },
  { id: "99999999", parentId: null },
]);

const TODAY = "2026-06-30";

describe("aggregate", () => {
  it("rolls children up into their top-level parent", () => {
    const result = aggregate([tx({ categoryId: "200100000", amountCents: -5_000 })], ROLLUP, TODAY);

    assert.deepEqual(result.groups.map((group) => group.categoryId), ["20000000"]);
  });

  it("does not count paying the card bill as spending or income", () => {
    const result = aggregate([
      tx({ id: "purchase", accountType: "CREDIT", categoryId: "11000000", amountCents: -10_000 }),
      tx({ id: "payment-out", accountType: "BANK", categoryId: "05100000", amountCents: -10_000 }),
      tx({ id: "payment-in", accountType: "CREDIT", categoryId: "05100000", amountCents: 10_000 }),
    ], ROLLUP, TODAY);

    assert.equal(result.spentCents, 10_000);
    assert.equal(result.receivedCents, 0);
  });

  it("does not count a transfer between your own accounts as spending", () => {
    assert.equal(aggregate([tx({ categoryId: "04000000", amountCents: -50_000 })], ROLLUP, TODAY).spentCents, 0);
  });

  it("still lists an excluded transfer as a group", () => {
    const result = aggregate([tx({ categoryId: "05100000", amountCents: -10_000 })], ROLLUP, TODAY);

    assert.deepEqual(result.groups.map((group) => group.categoryId), ["05000000"]);
  });

  it("counts a payment to another person as spending", () => {
    assert.equal(aggregate([tx({ categoryId: "05020000", amountCents: -30_000 })], ROLLUP, TODAY).spentCents, 30_000);
  });

  const FUTURE_CASES: readonly { readonly name: string; readonly localDate: string; readonly spent: number; readonly upcoming: number }[] = [
    { name: "yesterday counts as spent", localDate: "2026-06-29", spent: 20_000, upcoming: 0 },
    { name: "today counts as spent", localDate: "2026-06-30", spent: 20_000, upcoming: 0 },
    { name: "tomorrow counts as upcoming", localDate: "2026-07-01", spent: 0, upcoming: 1 },
    { name: "a far future instalment counts as upcoming", localDate: "2026-10-01", spent: 0, upcoming: 1 },
  ];

  for (const { name, localDate, spent, upcoming } of FUTURE_CASES) {
    it(`splits future rows at today, inclusive: ${name}`, () => {
      const result = aggregate([tx({ localDate, amountCents: -20_000 })], ROLLUP, TODAY);

      assert.equal(result.spentCents, spent);
      assert.equal(result.upcoming.count, upcoming);
    });
  }

  it("reports spent and received as magnitudes, not signed", () => {
    const result = aggregate([
      tx({ id: "out", amountCents: -10_000 }),
      tx({ id: "in", categoryId: "01000000", amountCents: 30_000 }),
    ], ROLLUP, TODAY);

    assert.equal(result.spentCents, 10_000);
    assert.equal(result.receivedCents, 30_000);
  });

  it("keeps a group total signed so a refund nets against a purchase", () => {
    const result = aggregate([
      tx({ id: "buy", amountCents: -10_000 }),
      tx({ id: "refund", amountCents: 4_000 }),
    ], ROLLUP, TODAY);

    assert.equal(result.groups[0]?.totalCents, -6_000);
  });

  it("takes the ten largest ids by absolute amount as the sample", () => {
    const rows = Array.from({ length: 15 }, (_, index) => tx({ id: `t-${index}`, amountCents: -(index + 1) * 100 }));
    const group = aggregate(rows, ROLLUP, TODAY).groups[0];

    assert.equal(group?.sampleIds.length, 10);
    assert.equal(group?.sampleIds[0], "t-14");
  });

  it("groups an uncategorized row separately from Other", () => {
    const result = aggregate([
      tx({ id: "none", categoryId: null, amountCents: -100 }),
      tx({ id: "other", categoryId: "99999999", amountCents: -200 }),
    ], ROLLUP, TODAY);

    assert.equal(result.groups.length, 2);
    assert.ok(result.groups.some((group) => group.categoryId === null));
  });

  it("reports a category absent from the tree rather than dropping it", () => {
    assert.throws(() => aggregate([tx({ categoryId: "88888888" })], ROLLUP, TODAY), /88888888/u);
  });

  it("returns zeroes rather than failing on an empty set", () => {
    const result = aggregate([], ROLLUP, TODAY);

    assert.deepEqual(result.groups, []);
    assert.equal(result.spentCents, 0);
  });

  it("orders groups by absolute total, largest first", () => {
    const result = aggregate([
      tx({ id: "small", categoryId: "11000000", amountCents: -100 }),
      tx({ id: "big", categoryId: "09000000", amountCents: -900 }),
    ], ROLLUP, TODAY);

    assert.deepEqual(result.groups.map((group) => group.categoryId), ["09000000", "11000000"]);
  });
});

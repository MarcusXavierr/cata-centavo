import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { aggregate } from "../../src/core/aggregate.ts";
import { derived } from "../fakes/transaction-builder.ts";

const TODAY = "2026-06-30";

describe("aggregate", () => {
  it("rolls children up into their top-level parent", () => {
    const result = aggregate([derived({ categoryId: "200100000", amountCents: -5_000 })], TODAY);

    assert.deepEqual(result.groups.map((group) => group.categoryId), ["20000000"]);
  });

  it("does not count paying the card bill as spending or income", () => {
    const result = aggregate([
      derived({ id: "purchase", accountType: "CREDIT", categoryId: "11000000", amountCents: -10_000 }),
      derived({ id: "payment-out", accountType: "BANK", categoryId: "05100000", amountCents: -10_000 }),
      derived({ id: "payment-in", accountType: "CREDIT", categoryId: "05100000", amountCents: 10_000 }),
    ], TODAY);

    assert.equal(result.spentCents, 10_000);
    assert.equal(result.receivedCents, 0);
  });

  it("does not count a transfer between your own accounts as spending", () => {
    assert.equal(aggregate([derived({ categoryId: "04000000", amountCents: -50_000 })], TODAY).spentCents, 0);
  });

  it("still lists an excluded transfer as a group", () => {
    const result = aggregate([derived({ categoryId: "05100000", amountCents: -10_000 })], TODAY);

    assert.deepEqual(result.groups.map((group) => group.categoryId), ["05000000"]);
  });

  it("counts a payment to another person as spending", () => {
    assert.equal(aggregate([derived({ categoryId: "05020000", amountCents: -30_000 })], TODAY).spentCents, 30_000);
  });

  const FUTURE_CASES: readonly {
    readonly name: string;
    readonly localDate: string;
    readonly spent: number;
    readonly upcoming: number;
    readonly upcomingCents: number;
  }[] = [
    { name: "yesterday counts as spent", localDate: "2026-06-29", spent: 20_000, upcoming: 0, upcomingCents: 0 },
    { name: "today counts as spent", localDate: "2026-06-30", spent: 20_000, upcoming: 0, upcomingCents: 0 },
    { name: "tomorrow counts as upcoming", localDate: "2026-07-01", spent: 0, upcoming: 1, upcomingCents: -20_000 },
    { name: "a far future instalment counts as upcoming", localDate: "2026-10-01", spent: 0, upcoming: 1, upcomingCents: -20_000 },
  ];

  for (const { name, localDate, spent, upcoming, upcomingCents } of FUTURE_CASES) {
    it(`splits future rows at today, inclusive: ${name}`, () => {
      const result = aggregate([derived({ localDate, amountCents: -20_000 })], TODAY);

      assert.equal(result.spentCents, spent);
      assert.equal(result.upcoming.count, upcoming);
      assert.equal(result.upcoming.totalCents, upcomingCents);
    });
  }

  it("keeps the upcoming total signed, and sums it across rows", () => {
    const result = aggregate([
      derived({ id: "a", localDate: "2026-07-01", amountCents: -20_000 }),
      derived({ id: "b", localDate: "2026-08-01", amountCents: -30_000 }),
    ], TODAY);

    assert.equal(result.upcoming.count, 2);
    assert.equal(result.upcoming.totalCents, -50_000);
  });

  it("counts the rows behind each group total", () => {
    const result = aggregate([
      derived({ id: "a", categoryId: "11000000", amountCents: -1_000 }),
      derived({ id: "b", categoryId: "11000000", amountCents: -2_000 }),
      derived({ id: "c", categoryId: "01000000", amountCents: 9_000 }),
    ], TODAY);

    const byCategory = new Map(result.groups.map((group) => [group.categoryId, group]));
    assert.equal(byCategory.get("11000000")?.count, 2);
    assert.equal(byCategory.get("11000000")?.totalCents, -3_000);
    assert.equal(byCategory.get("01000000")?.count, 1);
  });

  it("reports spent and received as magnitudes, not signed", () => {
    const result = aggregate([
      derived({ id: "out", amountCents: -10_000 }),
      derived({ id: "in", categoryId: "01000000", amountCents: 30_000 }),
    ], TODAY);

    assert.equal(result.spentCents, 10_000);
    assert.equal(result.receivedCents, 30_000);
  });

  it("keeps a group total signed so a refund nets against a purchase", () => {
    const result = aggregate([
      derived({ id: "buy", amountCents: -10_000 }),
      derived({ id: "refund", amountCents: 4_000 }),
    ], TODAY);

    assert.equal(result.groups[0]?.totalCents, -6_000);
  });

  it("takes the ten largest ids by absolute amount as the sample", () => {
    const rows = Array.from({ length: 15 }, (_, index) => derived({ id: `t-${index}`, amountCents: -(index + 1) * 100 }));
    const group = aggregate(rows, TODAY).groups[0];

    assert.equal(group?.sampleIds.length, 10);
    assert.equal(group?.sampleIds[0], "t-14");
  });

  it("groups an uncategorized row separately from Other", () => {
    const result = aggregate([
      derived({ id: "none", categoryId: null, amountCents: -100 }),
      derived({ id: "other", categoryId: "99999999", amountCents: -200 }),
    ], TODAY);

    assert.equal(result.groups.length, 2);
    assert.ok(result.groups.some((group) => group.categoryId === null));
  });

  it("groups a row nothing could categorize without dropping its amount", () => {
    const result = aggregate([derived({ categoryId: "88888888", category: null, categorySrc: null, amountCents: -7_000 })], TODAY);

    assert.deepEqual(result.groups.map((group) => group.categoryId), [null]);
    assert.equal(result.groups[0]?.totalCents, -7_000);
    assert.equal(result.spentCents, 7_000);
  });

  it("returns zeroes rather than failing on an empty set", () => {
    const result = aggregate([], TODAY);

    assert.deepEqual(result.groups, []);
    assert.equal(result.spentCents, 0);
  });

  it("orders groups by absolute total, largest first", () => {
    const result = aggregate([
      derived({ id: "small", categoryId: "11000000", amountCents: -100 }),
      derived({ id: "big", categoryId: "09000000", amountCents: -900 }),
    ], TODAY);

    assert.deepEqual(result.groups.map((group) => group.categoryId), ["09000000", "11000000"]);
  });
});

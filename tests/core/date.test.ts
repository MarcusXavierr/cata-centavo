import assert from "node:assert/strict";
import { test } from "node:test";

import { localDayOf, todayIn } from "../../src/core/date.ts";
import { fixedClock } from "../fakes/fixed-clock.ts";

const CASES: readonly { readonly name: string; readonly instant: string; readonly expected: string }[] = [
  { name: "Brazilian midnight rendered as UTC keeps its own day", instant: "2026-06-20T03:00:00.000Z", expected: "2026-06-20" },
  { name: "a late evening purchase stays in the month it was made", instant: "2026-07-01T01:00:00.000Z", expected: "2026-06-30" },
  { name: "UTC midnight belongs to the previous Brazilian day", instant: "2026-06-01T00:00:00.000Z", expected: "2026-05-31" },
  { name: "midday is unambiguous", instant: "2026-06-15T15:00:00.000Z", expected: "2026-06-15" },
];

test("localDayOf", async (t) => {
  for (const { name, instant, expected } of CASES) {
    await t.test(name, () => {
      assert.equal(localDayOf(instant), expected);
    });
  }
});

test("localDayOf refuses a value that is not a date", () => {
  assert.throws(() => localDayOf("not-a-date"), /not-a-date/u);
});

test("todayIn reads the clock, not the system time", () => {
  const clock = fixedClock(new Date("2026-07-01T01:00:00.000Z"));

  assert.equal(todayIn(clock), "2026-06-30");
});

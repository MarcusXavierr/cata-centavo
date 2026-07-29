import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { identifyOpenCycle, type ClosingDateSource } from "../../src/core/bill.ts";
import { todayIn } from "../../src/core/date.ts";
import { bill, billFixture, type BillFixture } from "../fakes/bill-builder.ts";

const CYCLE_CASES: readonly {
  readonly name: string;
  readonly fixture: BillFixture;
  readonly expected: { readonly openCycle: string; readonly source: ClosingDateSource } | null;
}[] = [
  {
    name: "a bill whose closing day has not passed is itself the open cycle",
    fixture: billFixture({ bills: [bill({ closingDate: "2026-08-08", dueDate: "2026-08-15" })], today: "2026-07-26" }),
    expected: { openCycle: "2026-08", source: "open-bill" },
  },
  {
    name: "a bill with no closing date and a future due date is still open",
    fixture: billFixture({ bills: [bill({ closingDate: null, dueDate: "2026-08-15" })], today: "2026-07-27" }),
    expected: { openCycle: "2026-08", source: "open-bill" },
  },
  {
    name: "otherwise the open cycle is the month after the newest closed bill",
    fixture: billFixture({ bills: [bill({ closingDate: "2026-07-08", dueDate: "2026-07-15" })], today: "2026-07-26" }),
    expected: { openCycle: "2026-08", source: "last-closed" },
  },
  {
    name: "a bill closing exactly today is still closing, not closed",
    fixture: billFixture({ bills: [bill({ closingDate: "2026-07-26", dueDate: "2026-08-02" })], today: "2026-07-26" }),
    expected: { openCycle: "2026-08", source: "open-bill" },
  },
  {
    name: "December rolls the year over",
    fixture: billFixture({ bills: [bill({ closingDate: "2026-12-08", dueDate: "2026-12-15" })], today: "2027-01-05" }),
    expected: { openCycle: "2027-01", source: "last-closed" },
  },
  {
    name: "with no bills the stored day wins over balanceDueDate",
    fixture: billFixture({ bills: [], storedDay: 20, balanceDueDate: "2026-07-15", today: "2026-07-26" }),
    expected: { openCycle: "2026-09", source: "local" },
  },
  {
    name: "a card closing on the 25th falls due the next month, and is tagged by that month",
    fixture: billFixture({ bills: [], storedDay: 25, balanceDueDate: "2026-07-05", today: "2026-07-10" }),
    expected: { openCycle: "2026-08", source: "local" },
  },
  {
    name: "the same card past its closing day moves both the cycle and the due month on",
    fixture: billFixture({ bills: [], storedDay: 25, balanceDueDate: "2026-07-05", today: "2026-07-26" }),
    expected: { openCycle: "2026-09", source: "local" },
  },
  {
    name: "a card falling due after it closes stays in the closing month",
    fixture: billFixture({ bills: [], storedDay: 20, balanceDueDate: "2026-07-25", today: "2026-07-10" }),
    expected: { openCycle: "2026-07", source: "local" },
  },
  {
    name: "a due day equal to the closing day is the same month, not the next",
    fixture: billFixture({ bills: [], storedDay: 20, balanceDueDate: "2026-07-20", today: "2026-07-10" }),
    expected: { openCycle: "2026-07", source: "local" },
  },
  {
    name: "the due month shift rolls the year over too",
    fixture: billFixture({ bills: [], storedDay: 25, balanceDueDate: "2026-12-05", today: "2026-12-26" }),
    expected: { openCycle: "2027-02", source: "local" },
  },
  {
    name: "without balanceDueDate there is no closing-to-due interval, so the closing month answers",
    fixture: billFixture({ bills: [], storedDay: 25, balanceDueDate: null, today: "2026-07-10" }),
    expected: { openCycle: "2026-07", source: "local" },
  },
  {
    name: "a stored day of 31 clamps to the last day of February, so the 28th still closes",
    fixture: billFixture({ bills: [], storedDay: 31, today: "2027-02-28" }),
    expected: { openCycle: "2027-04", source: "local" },
  },
  {
    name: "and the 27th does not",
    fixture: billFixture({ bills: [], storedDay: 31, today: "2027-02-27" }),
    expected: { openCycle: "2027-03", source: "local" },
  },
  {
    name: "with no bills and no stored day, balanceDueDate answers",
    fixture: billFixture({ bills: [], storedDay: null, balanceDueDate: "2026-07-15" }),
    expected: { openCycle: "2026-08", source: "due-date" },
  },
  {
    name: "with none of the four the cycle is not identifiable",
    fixture: billFixture({ bills: [], storedDay: null, balanceDueDate: null }),
    expected: null,
  },
];

describe("identifyOpenCycle", () => {
  for (const { name, fixture, expected } of CYCLE_CASES) {
    it(name, () => {
      assert.deepEqual(
        identifyOpenCycle(fixture.bills, fixture.storedDay, fixture.balanceDueDate, todayIn(fixture.clock)),
        expected,
      );
    });
  }
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { identifyOpenCycle, partitionBillRows, type ClosingDateSource } from "../../src/core/bill.ts";
import { todayIn } from "../../src/core/date.ts";
import type { DerivedTransaction } from "../../src/core/transaction.ts";
import { bill, billFixture, type BillFixture } from "../fakes/bill-builder.ts";
import { derived } from "../fakes/transaction-builder.ts";

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
    expected: { openCycle: "2026-08", source: "local" },
  },
  {
    name: "a stored day of 31 clamps to the last day of February, so the 28th still closes",
    fixture: billFixture({ bills: [], storedDay: 31, today: "2027-02-28" }),
    expected: { openCycle: "2027-03", source: "local" },
  },
  {
    name: "and the 27th does not",
    fixture: billFixture({ bills: [], storedDay: 31, today: "2027-02-27" }),
    expected: { openCycle: "2027-02", source: "local" },
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

const MEMBERSHIP_CASES: readonly {
  readonly name: string;
  readonly openBillId: string | null;
  readonly row: DerivedTransaction;
  readonly expected: "open" | "future" | "neither";
}[] = [
  { name: "a row carrying the open bill's own id is in the open cycle",
    openBillId: "open-bill", row: derived({ billId: "open-bill", billForecastDate: null }), expected: "open" },
  { name: "a row carrying a closed bill's id is in neither bucket",
    openBillId: "open-bill", row: derived({ billId: "closed-bill" }), expected: "neither" },
  { name: "with no open bill in the list, any billed row is in neither bucket",
    openBillId: null, row: derived({ billId: "closed-bill" }), expected: "neither" },
  { name: "an unbilled row forecast to the open cycle is in the open cycle",
    openBillId: null, row: derived({ billId: null, billForecastDate: "2026-08" }), expected: "open" },
  { name: "an unbilled row forecast to a past cycle is still in the open cycle",
    openBillId: null, row: derived({ billId: null, billForecastDate: "2026-07" }), expected: "open" },
  { name: "an unbilled row forecast beyond the open cycle is future",
    openBillId: null, row: derived({ billId: null, billForecastDate: "2026-09" }), expected: "future" },
  { name: "the unassigned-cycle sentinel is future, not January of year one",
    openBillId: null, row: derived({ billId: null, billForecastDate: "0001-01" }), expected: "future" },
  { name: "an unbilled row with no forecast at all falls to the open cycle",
    openBillId: null, row: derived({ billId: null, billForecastDate: null }), expected: "open" },
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

describe("partitionBillRows", () => {
  for (const { name, openBillId, row, expected } of MEMBERSHIP_CASES) {
    it(name, () => {
      const partition = partitionBillRows([row], "2026-08", openBillId);
      let actual: "open" | "future" | "neither" = "neither";
      if (partition.openCycleRows.includes(row)) {
        actual = "open";
      } else if (partition.futureRows.includes(row)) {
        actual = "future";
      }

      assert.equal(actual, expected);
    });
  }
});

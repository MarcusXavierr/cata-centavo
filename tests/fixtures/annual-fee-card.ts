import { bill, billFixture } from "../fakes/bill-builder.ts";
import { derived } from "../fakes/transaction-builder.ts";

const ACCOUNT_ID = "annual-fee-card";
const LOCAL_DATES = [
  "2025-08-08",
  "2025-09-08",
  "2025-10-08",
  "2025-11-08",
  "2025-12-08",
  "2026-01-08",
  "2026-02-08",
  "2026-03-08",
  "2026-04-08",
  "2026-05-08",
  "2026-06-08",
  "2026-07-08",
] as const;
const COUNTERS = [6, 7, 8, 9, 10, 11, 12, 1, 2, 3, 4, 5] as const;

export const annualFeeCard = billFixture({
  accountId: ACCOUNT_ID,
  today: "2026-07-30",
  bills: LOCAL_DATES.map((localDate, index) => bill({
    id: `annual-fee-bill-${index + 1}`,
    closingDate: localDate,
    dueDate: localDate,
  })),
  rows: LOCAL_DATES.map((localDate, index) => {
    const counter = COUNTERS[index];
    if (counter === undefined) {
      throw new Error("Annual-fee fixture date lacks a counter");
    }
    return derived({
      id: `annual-fee-${counter}`,
      accountId: ACCOUNT_ID,
      accountType: "CREDIT",
      accountSubtype: "CREDIT_CARD",
      localDate,
      amountCents: -5_500,
      description: "ANUIDADE DIFERENCIADA",
      descriptionNorm: "ANUIDADE DIFERENCIADA",
      billId: `annual-fee-bill-${index + 1}`,
      billForecastDate: localDate.slice(0, 7),
      instalmentNumber: counter,
      instalmentTotal: 12,
      purchaseDate: `${localDate}T00:00:00.000Z`,
    });
  }),
});

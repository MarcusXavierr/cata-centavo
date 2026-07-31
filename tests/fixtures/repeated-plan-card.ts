import { bill, billFixture } from "../fakes/bill-builder.ts";
import { derived } from "../fakes/transaction-builder.ts";

const ACCOUNT_ID = "repeated-plan-card";
const PURCHASE_DATES = [
  "2026-02-25",
  "2026-03-25",
  "2026-04-25",
  "2026-05-25",
  "2026-06-25",
] as const;

export const repeatedPlanCard = billFixture({
  accountId: ACCOUNT_ID,
  today: "2026-07-30",
  bills: PURCHASE_DATES.flatMap((localDate, index) => [1, 2].map((number) => bill({
    id: `repeated-plan-bill-${index + 1}-${number}`,
    closingDate: localDate,
    dueDate: localDate,
  }))),
  rows: [
    ...PURCHASE_DATES.flatMap((localDate, index) => [1, 2].map((number) => derived({
      id: `repeated-plan-${index + 1}-${number}`,
      accountId: ACCOUNT_ID,
      accountType: "CREDIT",
      accountSubtype: "CREDIT_CARD",
      localDate,
      amountCents: -3_945,
      description: "MERCADOLIVRE*MERCADOL",
      descriptionNorm: "MERCADOLIVRE*MERCADOL",
      billId: `repeated-plan-bill-${index + 1}-${number}`,
      billForecastDate: localDate.slice(0, 7),
      instalmentNumber: number,
      instalmentTotal: 2,
      purchaseDate: `${localDate}T00:00:00.000Z`,
    }))),
    derived({
      id: "repeated-plan-6-1",
      accountId: ACCOUNT_ID,
      accountType: "CREDIT",
      accountSubtype: "CREDIT_CARD",
      localDate: "2026-07-25",
      amountCents: -3_945,
      description: "MERCADOLIVRE*MERCADOL",
      descriptionNorm: "MERCADOLIVRE*MERCADOL",
      billId: null,
      billForecastDate: null,
      instalmentNumber: 1,
      instalmentTotal: 2,
      purchaseDate: "2026-07-25T00:00:00.000Z",
    }),
  ],
});

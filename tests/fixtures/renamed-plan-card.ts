import { bill, billFixture } from "../fakes/bill-builder.ts";
import { derived } from "../fakes/transaction-builder.ts";

const ACCOUNT_ID = "renamed-plan-card";
const PURCHASE_DATE = "2025-12-25T13:16:47.001Z";

export const renamedPlanCard = billFixture({
  accountId: ACCOUNT_ID,
  today: "2026-07-30",
  bills: [1, 2, 3, 4, 5, 6, 7].map((number) => bill({
    id: `renamed-plan-bill-${number}`,
    closingDate: `2025-${String(number).padStart(2, "0")}-08`,
    dueDate: `2026-${String(number).padStart(2, "0")}-15`,
  })),
  rows: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((number) => {
    let description = "AMAZON PRIME BR";
    if (number < 7) {
      description = "AMAZON PRIME";
    }
    let billId: string | null = null;
    if (number <= 7) {
      billId = `renamed-plan-bill-${number}`;
    }
    return derived({
      id: `renamed-plan-${number}`,
      accountId: ACCOUNT_ID,
      accountType: "CREDIT",
      accountSubtype: "CREDIT_CARD",
      localDate: "2025-12-25",
      amountCents: -1_390,
      description,
      descriptionNorm: description,
      billId,
      billForecastDate: `2026-${String(number).padStart(2, "0")}`,
      instalmentNumber: number,
      instalmentTotal: 12,
      purchaseDate: PURCHASE_DATE,
    });
  }),
});

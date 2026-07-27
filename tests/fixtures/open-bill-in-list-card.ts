import { bill, billFixture } from "../fakes/bill-builder.ts";
import { derived } from "../fakes/transaction-builder.ts";

const ACCOUNT_ID = "open-bill-in-list-card";
const OPEN_BILL_ID = "open-bill";

export const openBillInListCard = billFixture({
  accountId: ACCOUNT_ID,
  utilizationCents: 4_500,
  bills: [bill({ id: OPEN_BILL_ID, closingDate: "2026-08-08", dueDate: "2026-08-15", totalCents: 4_500 })],
  rows: [
    derived({
      id: "open-bill-purchase",
      accountId: ACCOUNT_ID,
      accountType: "CREDIT",
      accountSubtype: "CREDIT_CARD",
      occurredAt: "2026-07-18T15:00:00.000Z",
      localDate: "2026-07-18",
      amountCents: -3_000,
      description: "SYNTHETIC MARKET",
      descriptionNorm: "SYNTHETIC MARKET",
      billId: OPEN_BILL_ID,
    }),
    derived({
      id: "open-bill-refund",
      accountId: ACCOUNT_ID,
      accountType: "CREDIT",
      accountSubtype: "CREDIT_CARD",
      occurredAt: "2026-07-22T15:00:00.000Z",
      localDate: "2026-07-22",
      amountCents: 500,
      description: "SYNTHETIC MARKET REFUND",
      descriptionNorm: "SYNTHETIC MARKET REFUND",
      categoryId: "12000000",
      billId: OPEN_BILL_ID,
    }),
    derived({
      id: "open-bill-service",
      accountId: ACCOUNT_ID,
      accountType: "CREDIT",
      accountSubtype: "CREDIT_CARD",
      occurredAt: "2026-07-24T15:00:00.000Z",
      localDate: "2026-07-24",
      amountCents: -2_000,
      description: "SYNTHETIC SERVICE",
      descriptionNorm: "SYNTHETIC SERVICE",
      billId: OPEN_BILL_ID,
    }),
  ],
});

import { bill, billFixture } from "../fakes/bill-builder.ts";
import { derived } from "../fakes/transaction-builder.ts";

const ACCOUNT_ID = "bulk-posting-card";

export const bulkPostingCard = billFixture({
  accountId: ACCOUNT_ID,
  utilizationCents: 50_000,
  bills: [bill({ id: "bulk-posting-closed", totalCents: 5_000 })],
  rows: [1, 2, 3, 4, 5].map((instalmentNumber) => derived({
    id: `bulk-posting-${instalmentNumber}`,
    accountId: ACCOUNT_ID,
    accountType: "CREDIT",
    accountSubtype: "CREDIT_CARD",
    occurredAt: "2026-07-20T15:00:00.000Z",
    localDate: "2026-07-20",
    amountCents: -1_000,
    description: "BULK CAMERA",
    descriptionNorm: "BULK CAMERA",
    billForecastDate: "2026-08",
    instalmentNumber,
    instalmentTotal: 10,
  })),
});

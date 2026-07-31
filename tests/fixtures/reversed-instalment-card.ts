import { bill, billFixture } from "../fakes/bill-builder.ts";
import { derived } from "../fakes/transaction-builder.ts";

const ACCOUNT_ID = "reversed-instalment-card";
const ARAUJO = "ARAUJO LOJA";
const FIRST_BILL = "14cf4936";
const SECOND_BILL = "48c42481";

/** Real-card-shaped reversal: only the metadata-bearing credit offsets its debit position. */
export const reversedInstalmentCard = billFixture({
  accountId: ACCOUNT_ID,
  today: "2026-07-30",
  bills: [
    bill({ id: FIRST_BILL, closingDate: "2026-06-08", dueDate: "2026-06-15" }),
    bill({ id: SECOND_BILL, closingDate: "2026-07-08", dueDate: "2026-07-15" }),
  ],
  rows: [
    derived({
      id: "araujo-debit-1-2",
      accountId: ACCOUNT_ID,
      accountType: "CREDIT",
      accountSubtype: "CREDIT_CARD",
      localDate: "2026-05-28",
      amountCents: -87_450,
      description: ARAUJO,
      descriptionNorm: ARAUJO,
      billId: FIRST_BILL,
      instalmentNumber: 1,
      instalmentTotal: 2,
      purchaseDate: "2026-05-28T14:32:34.000Z",
    }),
    derived({
      id: "araujo-credit-1-2",
      accountId: ACCOUNT_ID,
      accountType: "CREDIT",
      accountSubtype: "CREDIT_CARD",
      localDate: "2026-05-28",
      amountCents: 87_450,
      description: ARAUJO,
      descriptionNorm: ARAUJO,
      billId: FIRST_BILL,
      instalmentNumber: 1,
      instalmentTotal: 2,
      purchaseDate: "2026-05-28T01:01:01.000Z",
    }),
    derived({
      id: "araujo-debit-1-3",
      accountId: ACCOUNT_ID,
      accountType: "CREDIT",
      accountSubtype: "CREDIT_CARD",
      localDate: "2026-05-28",
      amountCents: -116_600,
      description: ARAUJO,
      descriptionNorm: ARAUJO,
      billId: FIRST_BILL,
      instalmentNumber: 1,
      instalmentTotal: 3,
      purchaseDate: "2026-05-28T14:49:31.000Z",
    }),
    derived({
      id: "araujo-debit-2-3",
      accountId: ACCOUNT_ID,
      accountType: "CREDIT",
      accountSubtype: "CREDIT_CARD",
      localDate: "2026-05-28",
      amountCents: -116_600,
      description: ARAUJO,
      descriptionNorm: ARAUJO,
      billId: SECOND_BILL,
      instalmentNumber: 2,
      instalmentTotal: 3,
      purchaseDate: "2026-05-28T14:49:31.000Z",
    }),
    derived({
      id: "araujo-unrelated-refund",
      accountId: ACCOUNT_ID,
      accountType: "CREDIT",
      accountSubtype: "CREDIT_CARD",
      localDate: "2026-05-28",
      amountCents: 174_900,
      description: ARAUJO,
      descriptionNorm: ARAUJO,
      billId: SECOND_BILL,
    }),
  ],
});

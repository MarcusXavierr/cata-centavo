import { z } from "zod";

import type { TaxonomyEntry } from "../core/taxonomy.ts";

/**
 * The raw bodies we read from Pluggy, described rather than assumed.
 *
 * We do not reuse the SDK's entity types here, and the reason is specific: they
 * declare fields like `lastUpdatedAt` as `Date`, which is only true inside the
 * SDK, where a reviver installed in `got` turns every ISO-8601 string into a
 * `Date` (`transforms.js`). Parsing the body ourselves, the value is a string
 * and the type would be lying. Inferring from a schema makes that impossible.
 *
 * This is also ADR Phase 0.5 step 5 as code: trust nothing but the raw body.
 * The prior implementation could never observe that free-tier `category` comes
 * back null, because its own serializer deleted the evidence first (§16.2).
 *
 * Unknown keys are dropped, not rejected. Pluggy adding a field is not our
 * problem; Pluggy removing one we read is, and that is what these catch.
 */

export const AUTH_RESPONSE = z.object({
  apiKey: z.string().min(1),
});

/**
 * Why `statusDetail` may fall back to nothing rather than failing the parse: it
 * is a bag keyed by product name, its shape is documented only by example, and
 * what we read out of it is advisory — which product could not be updated this
 * time. Losing a whole completed sync to an unexpected key in an advisory field
 * would be the worse trade. Nothing about the money passes through here.
 */
const STATUS_DETAIL = z
  .record(
    z.string(),
    z
      .object({ warnings: z.array(z.object({ message: z.string() })).nullish() })
      .nullish(),
  )
  .nullish()
  .catch(null);

export const ITEM = z.object({
  id: z.string().min(1),
  connector: z.object({ name: z.string() }),
  status: z.string(),
  executionStatus: z.string().nullish(),
  lastUpdatedAt: z.string().nullable(),
  /** Present when the institution is waiting on a human. */
  parameter: z.object({ name: z.string(), label: z.string() }).nullish(),
  statusDetail: STATUS_DETAIL,
  consecutiveFailedLoginAttempts: z.number().nullish(),
});

export type WireItem = z.infer<typeof ITEM>;

/**
 * `GET /consents?itemId=` — the paged envelope of the consent behind one item.
 *
 * The consent's own `itemId` deliberately does not enter this schema.
 * `docs/research/2026-07-26-phase-0-5-recon.md` §"`GET /consents?itemId=`
 * returns a consent belonging to a different item" found it carries the UUID
 * of the inner MeuPluggy item — a different one on each of the three
 * connections observed, none matching a configured id. Reading it only
 * creates the temptation to join a consent back to our connection by that
 * field, which would silently produce zero matches. The only reliable
 * association is "this is what the endpoint returned when asked about that
 * item".
 */
export const CONSENT = z.object({
  id: z.string().min(1),
  expiresAt: z.string().nullish(),
  revokedAt: z.string().nullish(),
  products: z.array(z.string()).nullish(),
});

export const CONSENT_PAGE = z.object({
  results: z.array(CONSENT),
  total: z.number(),
  totalPages: z.number(),
  page: z.number(),
});

export type WireConsent = z.infer<typeof CONSENT>;

export const ACCOUNT = z.object({
  id: z.string().min(1),
  itemId: z.string().min(1),
  type: z.string(),
  subtype: z.string().nullish(),
  name: z.string(),
  marketingName: z.string().nullish(),
  balance: z.number(),
  currencyCode: z.string(),
  creditData: z
    .object({
      brand: z.string().nullish(),
      balanceCloseDate: z.string().nullish(),
      balanceDueDate: z.string().nullish(),
      availableCreditLimit: z.number().nullish(),
      creditLimit: z.number().nullish(),
      disaggregatedCreditLimits: z
        .array(
          z.object({
            creditLineLimitType: z.string().nullish(),
            customizedLimitAmount: z.number().nullish(),
          }),
        )
        .nullish(),
    })
    .nullish(),
});

/** Pluggy's offset envelope for `/accounts`. */
export const ACCOUNT_PAGE = z.object({
  total: z.number(),
  totalPages: z.number(),
  page: z.number(),
  results: z.array(ACCOUNT),
});

export type WireAccount = z.infer<typeof ACCOUNT>;

const BILL_AMOUNT = z.object({
  amount: z.number(),
});

/** The raw `GET /bills?accountId=` body for one credit-card statement. */
export const BILL = z.object({
  id: z.string(),
  accountId: z.string().optional(),
  billClosingDate: z.string().nullish(),
  dueDate: z.string(),
  totalAmount: z.number(),
  totalAmountCurrencyCode: z.string().nullish(),
  minimumPaymentAmount: z.number().nullish(),
  allowsInstallments: z.boolean().nullish(),
  financeCharges: z.array(BILL_AMOUNT),
  payments: z.array(BILL_AMOUNT),
});

export type WireBill = z.infer<typeof BILL>;

/** Pluggy's offset envelope for `/bills`. */
export const BILL_PAGE = z.object({
  total: z.number(),
  totalPages: z.number(),
  page: z.number(),
  results: z.array(BILL),
});

/** Nested fields Pluggy omits entirely when a card row has no such detail. */
export const CREDIT_CARD_METADATA = z.object({
  billId: z.string().optional(),
  installmentNumber: z.number().optional(),
  totalInstallments: z.number().optional(),
  cardNumber: z.string().optional(),
  payeeMCC: z.number().optional(),
  purchaseDate: z.string().optional(),
  feeType: z.string().optional(),
  billForecastDate: z.string().optional(),
});

export const PAYMENT_DATA = z.object({
  receiver: z
    .object({
      name: z.string().nullish(),
      documentNumber: z.object({ value: z.string().optional(), type: z.string().optional() }).optional(),
    })
    .nullish(),
  paymentMethod: z.string().nullish(),
});

export const TRANSACTION = z.object({
  id: z.string(),
  accountId: z.string(),
  date: z.string(),
  description: z.string(),
  descriptionRaw: z.string().nullish(),
  amount: z.number(),
  amountInAccountCurrency: z.number().nullish(),
  currencyCode: z.string().nullish(),
  category: z.string().nullish(),
  categoryId: z.string().nullish(),
  status: z.string().nullish(),
  creditCardMetadata: CREDIT_CARD_METADATA.nullish(),
  paymentData: PAYMENT_DATA.nullish(),
});

export type WireTransaction = z.infer<typeof TRANSACTION>;

/** The cursor-paginated envelope for `/v2/transactions`. */
export const TRANSACTION_PAGE = z.object({
  results: z.array(TRANSACTION),
  next: z.string().nullable(),
});

export const CATEGORY = z.object({
  id: z.string(),
  description: z.string(),
  descriptionTranslated: z.string().nullish(),
  parentId: z.string().nullish(),
  parentDescription: z.string().nullish(),
});

export const CATEGORY_PAGE = z.object({
  results: z.array(CATEGORY),
  total: z.number(),
  totalPages: z.number(),
  page: z.number(),
});

type CategoryPage = z.infer<typeof CATEGORY_PAGE>;

/** Reduces the one supported category page into the pure core taxonomy shape. */
export function parseCategoryPage(page: CategoryPage): readonly TaxonomyEntry[] {
  if (page.totalPages !== 1) {
    throw new Error(`Categories totalPages is ${page.totalPages}; expected one complete page`);
  }

  return page.results.map((category) => ({
    id: category.id,
    parentId: category.parentId ?? null,
    parentDescription: category.parentDescription ?? null,
  }));
}

/**
 * Pluggy's error envelope. Read on every non-2xx, because the status alone is not
 * a diagnosis: one 400 means a malformed request, another means a consent the
 * user revoked, and only `codeDescription` and `message` separate them. Throwing
 * "Pluggy returned 400" and dropping the rest is §16.2's scar, where the evidence
 * was deleted before a human could see it.
 *
 * Every field is optional and `data` falls back rather than failing, because an
 * error we cannot fully parse is still an error worth reporting.
 */
export const API_ERROR = z.object({
  codeDescription: z.string().nullish(),
  message: z.string().nullish(),
  data: z
    .object({ canRetryAfterDate: z.string().nullish() })
    .nullish()
    .catch(null),
});

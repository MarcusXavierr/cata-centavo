import { CATEGORIES, type CategoryId } from "./category.ts";

/**
 * One row of the MCC table: the winning category plus the evidence behind it.
 *
 * `agreeing` of `samples` observed transactions carried that category, so the
 * agreement rate is `agreeing / samples`. Both are stored as counts rather than
 * a rounded rate because the counts are exact and the rate is derivable.
 * Confidence lives in the data, not in a docblock, because a docblock listing
 * the shaky rows drifts the moment the table is re-derived — and because the
 * seed migration and `doctor` can then surface a coin flip as one.
 */
export type MccMapping = {
  readonly mcc: number;
  readonly category: CategoryId;
  readonly samples: number;
  readonly agreeing: number;
};

/**
 * ISO 18245 merchant category code → category, for the codes that show up in
 * real statements. ADR §12.4 step 3 asks for exactly this and says so: cover
 * "the codes that actually show up in real statements. All 1000 are not needed
 * up front." This table is the reason the mapping waited for data.
 *
 * The signal matters because the free tier is expected to stop returning
 * `category` on transactions. When it does, `creditCardMetadata.payeeMCC` is
 * the only categorization left on a card transaction (ADR §12.1's asymmetry).
 *
 * **Provenance, stated honestly.** Derived on 2026-07-26 from one wallet, three
 * institutions, 1123 card transactions carrying both an MCC and a category.
 * Each observed category was rolled up to its top-level ancestor and the most
 * frequent ancestor won. That is 87 of the roughly 1000 ISO 18245 codes: it
 * covers what one person spends on, not the code space.
 *
 * **The winner is a plurality, not always a majority.** 78 of the 87 rows are
 * unanimous; the weakest is MCC 5968 at 12 of 25. Those rows are mapped by the
 * same rule as the rest, deliberately — but `samples` and `agreeing` are there
 * so nobody mistakes one for a 192-sample unanimous mapping.
 *
 * Seeded into `cache.db.mcc_categories` rather than consulted from JavaScript,
 * because `getTransactions`' `categories` filter runs in SQL (ADR §12.2).
 */
export const MCC_CATEGORIES: readonly MccMapping[] = [
  { mcc:  780, category: CATEGORIES.transfers.id,        samples:   2, agreeing:   2 },
  { mcc: 1740, category: CATEGORIES.housing.id,          samples:   1, agreeing:   1 },
  { mcc: 2741, category: CATEGORIES.services.id,         samples:   1, agreeing:   1 },
  { mcc: 3247, category: CATEGORIES.travel.id,           samples:   1, agreeing:   1 },
  { mcc: 3300, category: CATEGORIES.travel.id,           samples:   2, agreeing:   2 },
  { mcc: 4111, category: CATEGORIES.transportation.id,   samples:   1, agreeing:   1 },
  { mcc: 4121, category: CATEGORIES.transportation.id,   samples: 192, agreeing: 192 },
  { mcc: 4131, category: CATEGORIES.transportation.id,   samples:  17, agreeing:  17 },
  { mcc: 4722, category: CATEGORIES.travel.id,           samples:  36, agreeing:  32 },
  { mcc: 4812, category: CATEGORIES.services.id,         samples:   4, agreeing:   4 },
  { mcc: 4814, category: CATEGORIES.services.id,         samples:  11, agreeing:  11 },
  { mcc: 4816, category: CATEGORIES.digitalServices.id,  samples:   4, agreeing:   4 },
  { mcc: 4899, category: CATEGORIES.digitalServices.id,  samples:  12, agreeing:  12 },
  { mcc: 5131, category: CATEGORIES.shopping.id,         samples:   3, agreeing:   3 },
  { mcc: 5139, category: CATEGORIES.shopping.id,         samples:   3, agreeing:   3 },
  { mcc: 5199, category: CATEGORIES.shopping.id,         samples:   1, agreeing:   1 },
  { mcc: 5211, category: CATEGORIES.housing.id,          samples:   1, agreeing:   1 },
  { mcc: 5300, category: CATEGORIES.groceries.id,        samples:  11, agreeing:  11 },
  { mcc: 5309, category: CATEGORIES.shopping.id,         samples:   1, agreeing:   1 },
  { mcc: 5310, category: CATEGORIES.shopping.id,         samples:  10, agreeing:  10 },
  { mcc: 5311, category: CATEGORIES.shopping.id,         samples:   9, agreeing:   7 },
  { mcc: 5331, category: CATEGORIES.shopping.id,         samples:   2, agreeing:   2 },
  { mcc: 5411, category: CATEGORIES.groceries.id,        samples:  46, agreeing:  46 },
  { mcc: 5422, category: CATEGORIES.groceries.id,        samples:  44, agreeing:  44 },
  { mcc: 5441, category: CATEGORIES.groceries.id,        samples:   4, agreeing:   4 },
  { mcc: 5451, category: CATEGORIES.groceries.id,        samples:   1, agreeing:   1 },
  { mcc: 5462, category: CATEGORIES.groceries.id,        samples:  75, agreeing:  75 },
  { mcc: 5499, category: CATEGORIES.foodAndDrinks.id,    samples:  27, agreeing:  16 },
  { mcc: 5541, category: CATEGORIES.transportation.id,   samples:   1, agreeing:   1 },
  { mcc: 5611, category: CATEGORIES.shopping.id,         samples:   5, agreeing:   5 },
  { mcc: 5651, category: CATEGORIES.shopping.id,         samples:  16, agreeing:  16 },
  { mcc: 5655, category: CATEGORIES.shopping.id,         samples:   1, agreeing:   1 },
  { mcc: 5661, category: CATEGORIES.shopping.id,         samples:   1, agreeing:   1 },
  { mcc: 5691, category: CATEGORIES.shopping.id,         samples:   4, agreeing:   4 },
  { mcc: 5697, category: CATEGORIES.shopping.id,         samples:   1, agreeing:   1 },
  { mcc: 5698, category: CATEGORIES.shopping.id,         samples:   2, agreeing:   2 },
  { mcc: 5699, category: CATEGORIES.shopping.id,         samples:   1, agreeing:   1 },
  { mcc: 5714, category: CATEGORIES.housing.id,          samples:   1, agreeing:   1 },
  { mcc: 5722, category: CATEGORIES.shopping.id,         samples:   2, agreeing:   2 },
  { mcc: 5732, category: CATEGORIES.shopping.id,         samples:   1, agreeing:   1 },
  { mcc: 5734, category: CATEGORIES.shopping.id,         samples:  35, agreeing:  28 },
  { mcc: 5812, category: CATEGORIES.foodAndDrinks.id,    samples: 105, agreeing:  94 },
  { mcc: 5813, category: CATEGORIES.foodAndDrinks.id,    samples:  20, agreeing:  20 },
  { mcc: 5814, category: CATEGORIES.foodAndDrinks.id,    samples:  90, agreeing:  84 },
  { mcc: 5815, category: CATEGORIES.digitalServices.id,  samples:  43, agreeing:  43 },
  { mcc: 5818, category: CATEGORIES.digitalServices.id,  samples:   1, agreeing:   1 },
  { mcc: 5912, category: CATEGORIES.healthcare.id,       samples:  55, agreeing:  55 },
  { mcc: 5921, category: CATEGORIES.groceries.id,        samples:   5, agreeing:   5 },
  { mcc: 5942, category: CATEGORIES.shopping.id,         samples:  24, agreeing:  24 },
  { mcc: 5943, category: CATEGORIES.shopping.id,         samples:   2, agreeing:   2 },
  { mcc: 5944, category: CATEGORIES.shopping.id,         samples:   2, agreeing:   2 },
  { mcc: 5947, category: CATEGORIES.shopping.id,         samples:   1, agreeing:   1 },
  { mcc: 5962, category: CATEGORIES.travel.id,           samples:   7, agreeing:   7 },
  { mcc: 5963, category: CATEGORIES.shopping.id,         samples:   1, agreeing:   1 },
  { mcc: 5968, category: CATEGORIES.shopping.id,         samples:  25, agreeing:  12 },
  { mcc: 5977, category: CATEGORIES.shopping.id,         samples:   4, agreeing:   3 },
  { mcc: 5992, category: CATEGORIES.shopping.id,         samples:   2, agreeing:   2 },
  { mcc: 5999, category: CATEGORIES.shopping.id,         samples:   3, agreeing:   3 },
  { mcc: 6010, category: CATEGORIES.transfers.id,        samples:   6, agreeing:   6 },
  { mcc: 7011, category: CATEGORIES.travel.id,           samples:   5, agreeing:   5 },
  { mcc: 7216, category: CATEGORIES.services.id,         samples:  36, agreeing:  36 },
  { mcc: 7221, category: CATEGORIES.services.id,         samples:   1, agreeing:   1 },
  { mcc: 7230, category: CATEGORIES.services.id,         samples:   2, agreeing:   2 },
  { mcc: 7299, category: CATEGORIES.shopping.id,         samples:   1, agreeing:   1 },
  { mcc: 7338, category: CATEGORIES.services.id,         samples:   2, agreeing:   2 },
  { mcc: 7349, category: CATEGORIES.services.id,         samples:   1, agreeing:   1 },
  { mcc: 7372, category: CATEGORIES.digitalServices.id,  samples:   3, agreeing:   3 },
  { mcc: 7379, category: CATEGORIES.services.id,         samples:   9, agreeing:   9 },
  { mcc: 7392, category: CATEGORIES.services.id,         samples:   1, agreeing:   1 },
  { mcc: 7395, category: CATEGORIES.services.id,         samples:   1, agreeing:   1 },
  { mcc: 7399, category: CATEGORIES.services.id,         samples:   3, agreeing:   3 },
  { mcc: 7622, category: CATEGORIES.services.id,         samples:   1, agreeing:   1 },
  { mcc: 7996, category: CATEGORIES.leisure.id,          samples:   1, agreeing:   1 },
  { mcc: 7997, category: CATEGORIES.services.id,         samples:   6, agreeing:   6 },
  { mcc: 7999, category: CATEGORIES.leisure.id,          samples:   1, agreeing:   1 },
  { mcc: 8011, category: CATEGORIES.healthcare.id,       samples:   5, agreeing:   5 },
  { mcc: 8021, category: CATEGORIES.healthcare.id,       samples:   7, agreeing:   7 },
  { mcc: 8043, category: CATEGORIES.healthcare.id,       samples:   3, agreeing:   3 },
  { mcc: 8220, category: CATEGORIES.services.id,         samples:  14, agreeing:  14 },
  { mcc: 8299, category: CATEGORIES.services.id,         samples:  13, agreeing:  13 },
  { mcc: 8398, category: CATEGORIES.donations.id,        samples:   1, agreeing:   1 },
  { mcc: 8661, category: CATEGORIES.donations.id,        samples:   2, agreeing:   2 },
  { mcc: 8699, category: CATEGORIES.services.id,         samples:   1, agreeing:   1 },
  { mcc: 8931, category: CATEGORIES.services.id,         samples:   3, agreeing:   3 },
  { mcc: 8999, category: CATEGORIES.services.id,         samples:   6, agreeing:   4 },
  { mcc: 9399, category: CATEGORIES.services.id,         samples:   4, agreeing:   4 },
  { mcc: 9994, category: CATEGORIES.shopping.id,         samples:   1, agreeing:   1 },
];

const BY_MCC: ReadonlyMap<number, MccMapping> = new Map(MCC_CATEGORIES.map((entry) => [entry.mcc, entry]));

/**
 * The category an MCC defaults to, or `undefined` when we have never seen the
 * code. There is no fallback category on purpose: an unknown MCC has no answer,
 * and ADR §12.3's `COALESCE` chain is built to fall through to no category.
 */
export function categoryForMcc(mcc: number): CategoryId | undefined {
  return BY_MCC.get(mcc)?.category;
}

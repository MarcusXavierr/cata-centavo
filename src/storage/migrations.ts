import { MCC_CATEGORIES } from "../core/mcc.ts";

export type Migration = {
  readonly to: number;
  readonly up: string;
};

/**
 * The MCC seed is generated from `src/core/mcc.ts` so the table has one source.
 * Values are interpolated rather than bound because a migration's `up` is a
 * script, not a statement — the inputs are a compile-time constant of integers
 * and closed-list category ids, so there is no untrusted string here.
 */
function seedMccCategories(): string {
  return MCC_CATEGORIES
    .map((row) => `INSERT INTO mcc_categories (mcc, category, samples, agreeing) VALUES ('${row.mcc}', '${row.category}', ${row.samples}, ${row.agreeing});`)
    .join("\n");
}

/**
 * Droppable: any mismatch is resolved by refetching from Pluggy (§10).
 *
 * **Bump `to` when the description normalizer changes.** `description_norm` is
 * written at insert and never recomputed, so appending an acquirer prefix to
 * `core/description.ts` leaves every cached row carrying the old value. The
 * rebuild policy is the re-derive pass, and this number is what triggers it.
 *
 * Under `rebuild`, `apply` replays every entry from 0 against a dropped file,
 * so a future `{to: 2}` is an additional statement rather than an `ALTER` — a
 * `CREATE TABLE transactions` in both entries would fail on the second.
 */
export const CACHE_MIGRATIONS: readonly Migration[] = [
  {
    to: 1,
    up: `
      CREATE TABLE transactions (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        connection_id TEXT NOT NULL,
        account_type TEXT NOT NULL,
        account_subtype TEXT,
        occurred_at TEXT NOT NULL,
        local_date TEXT NOT NULL,
        amount_cents INTEGER NOT NULL,
        currency TEXT NOT NULL,
        original_amount_cents INTEGER,
        original_currency TEXT,
        description TEXT NOT NULL,
        description_norm TEXT NOT NULL,
        category_id TEXT,
        document TEXT,
        counterparty_name TEXT,
        payment_method TEXT,
        mcc TEXT,
        bill_id TEXT,
        instalment_number INTEGER,
        instalment_total INTEGER,
        purchase_date TEXT
      );
      CREATE INDEX transactions_by_date ON transactions(local_date DESC, id DESC);
      CREATE INDEX transactions_by_account ON transactions(account_id, local_date DESC);

      CREATE TABLE transaction_sync (
        account_id TEXT PRIMARY KEY,
        connection_id TEXT NOT NULL,
        last_updated_at TEXT
      );
    `,
  },
  {
    to: 2,
    up: `
      ALTER TABLE transactions ADD COLUMN top_category_id TEXT;
      CREATE INDEX transactions_by_document ON transactions(document);

      CREATE TABLE mcc_categories (
        mcc TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        samples INTEGER NOT NULL,
        agreeing INTEGER NOT NULL
      );
      ${seedMccCategories()}
    `,
  },
  {
    to: 3,
    up: `
      ALTER TABLE transactions ADD COLUMN bill_forecast_date TEXT;
    `,
  },
];

/** Never dropped: overrides, rules and closing days live here (§10). */
export const DATA_MIGRATIONS: readonly Migration[] = [
  {
    to: 1,
    up: `
      CREATE TABLE category_overrides (
        transaction_id TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE counterparty_categories (
        document TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        origin TEXT NOT NULL,
        samples INTEGER,
        agreeing INTEGER,
        created_at TEXT NOT NULL
      );

      CREATE TABLE category_snapshot (
        transaction_id TEXT PRIMARY KEY,
        category_id TEXT NOT NULL,
        top_category_id TEXT,
        harvested_at TEXT NOT NULL
      );
    `,
  },
];

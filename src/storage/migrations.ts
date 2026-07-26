export type Migration = {
  readonly to: number;
  readonly up: string;
};

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
];

/** Never dropped: overrides, rules and closing days live here (§10). */
export const DATA_MIGRATIONS: readonly Migration[] = [];

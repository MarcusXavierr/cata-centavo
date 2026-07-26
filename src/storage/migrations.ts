import type { Migration } from "./db.ts";

/**
 * Both chains are empty, and that is not an oversight.
 *
 * `accounts` and `transactions` belong to Phases 1 and 2, and
 * `category_overrides`, `counterparty_categories` and `card_closing_day` to
 * Phase 3 and 4 (ADR §12.2, §14.3). Creating any of them now would be inventing
 * a schema ahead of the decisions that shape it — §12.4 in particular says the
 * taxonomy has to be fixed before the MCC table can exist at all.
 *
 * The runner ships anyway. It is what makes the next phase cost one entry in
 * one of these arrays instead of a design, and its behaviour is already proven
 * against synthetic chains in `tests/storage/db.test.ts`.
 */

/** Droppable: any mismatch is resolved by refetching from Pluggy (§10). */
export const CACHE_MIGRATIONS: readonly Migration[] = [];

/** Never dropped: overrides, rules and closing days live here (§10). */
export const DATA_MIGRATIONS: readonly Migration[] = [];

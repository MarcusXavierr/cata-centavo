import { BRANCHES } from "../core/category-source.ts";

/**
 * The six branches as six columns, plus the durable leaf.
 *
 * `c_leaf` is the finest category we still know for the row: what Pluggy sends
 * today, and what the snapshot remembers once it stops sending anything. It is
 * not a seventh branch — it is not rolled up and never competes for the derived
 * category. It exists because the self-transfer exclusion in `core/aggregate.ts`
 * distinguishes a credit card payment from an ordinary transfer, and only the
 * leaf carries that distinction. Reading `transactions.category_id` directly
 * there would let every card bill payment re-enter `spent` the day the plan
 * drops to free.
 *
 * Resolution happens in `core/category-source.ts`, driven by the same array
 * that builds this.
 *
 * There is deliberately no `CREATE VIEW`. A view living in the droppable file
 * and referencing `userdata.` would couple `cache.db`'s schema to a schema name
 * that has to be attached already — including during the migration run at
 * startup, before any attach has happened.
 */
export const DERIVED_COLUMNS = `
  (SELECT o.category FROM userdata.category_overrides o
     WHERE o.transaction_id = t.id)                                AS c_override,
  (SELECT c.category FROM userdata.counterparty_categories c
     WHERE t.document IS NOT NULL AND c.document = t.document AND c.origin = 'manual')        AS c_counterparty,
  t.top_category_id                                                AS c_pluggy,
  (SELECT s.top_category_id FROM userdata.category_snapshot s
     WHERE s.transaction_id = t.id)                                AS c_snapshot,
  (SELECT c.category FROM userdata.counterparty_categories c
     WHERE t.document IS NOT NULL AND c.document = t.document AND c.origin = 'learned')       AS c_learned,
  (SELECT m.category FROM mcc_categories m WHERE m.mcc = t.mcc)    AS c_mcc,
  COALESCE(t.category_id, (SELECT s.category_id FROM userdata.category_snapshot s
     WHERE s.transaction_id = t.id))                               AS c_leaf
`;

export const DERIVED_CATEGORY = `COALESCE(${BRANCHES.map((branch) => `c_${branch}`).join(", ")})`;

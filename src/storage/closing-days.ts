import type { DatabaseSync } from "node:sqlite";

import type { Clock, ClosingDay, ClosingDayStore } from "../core/contracts.ts";

const CLOSING_DAY_UPSERT = `
  INSERT INTO userdata.card_closing_day (account_id, day, created_at, updated_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(account_id) DO UPDATE SET
    day = excluded.day,
    updated_at = excluded.updated_at
`;

const systemClock: Clock = { now: () => new Date() };

/** Builds the local store for user-provided card billing-cycle closing days. */
export function createClosingDayStore(db: DatabaseSync, clock: Clock = systemClock): ClosingDayStore {
  const upsert = db.prepare(CLOSING_DAY_UPSERT);
  const list = db.prepare("SELECT account_id, day FROM userdata.card_closing_day ORDER BY account_id");
  const remove = db.prepare("DELETE FROM userdata.card_closing_day WHERE account_id = ?");

  return {
    list: () => listClosingDays(list),
    set: (accountId, day) => {
      const now = clock.now().toISOString();
      upsert.run(accountId, day, now, now);
    },
    delete: (accountId) => Number(remove.run(accountId).changes),
  };
}

function listClosingDays(statement: ReturnType<DatabaseSync["prepare"]>): readonly ClosingDay[] {
  const rows = statement.all() as Record<string, unknown>[];
  return rows.map((row) => ({ accountId: String(row["account_id"]), day: Number(row["day"]) }));
}

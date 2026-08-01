# Changelog

## 0.3.1: 2026-07-31

### Bug Fixes

- **`listTransactions`** — a PIX transfer whose receiver has no document on file no longer takes the whole page down with it.
  - Pluggy sends `documentNumber: null` there, and the schema accepted only `undefined`
  - Fixed by @Trecto34 in #25

- **Starting under an old Node** — the CLI now says which version it needs and which one it got, instead of crashing inside the module loader.
  - `node:sqlite` used to throw `ERR_UNKNOWN_BUILTIN_MODULE` before any of our code ran
  - The message points at PATH, since `npx` runs whatever node comes first and an MCP client never reads your shell profile
  - The floor is still 22.13.0, and a version string we cannot parse is let through rather than blocked

### Notes

- The README now recommends `npx cata-centavo@latest`. npm keeps a cache for `npx`, and a bare `npx cata-centavo` can be served out of it for months without the registry ever being asked whether something newer exists. Naming the tag makes your client check on every start.

## 0.3.0: 2026-07-31

### Features

- **`listInstalmentPlans`** — credit card purchases still being paid off, grouped back together from the rows a bank publishes one instalment at a time.
  - Merchant, purchase total, per-instalment amount, instalments paid and remaining, money still owed, and the cycle the last instalment falls due on
  - `accountId` and `connectionId` filters, `includeSettled` for the finished and reversed plans
  - Every figure says whether the bank published the rows behind it or the tool projected it from the instalments that did arrive
  - A refunded instalment cancels the position it belongs to instead of surfacing as a purchase of its own
  - A plan the bank renames halfway through stays one plan
  - An annual fee that restarts each year is flagged as a renewal rather than filtered out

### Notes

- An instalment counts as paid only once it lands on a bill the bank has closed. Rows that are posted but not yet billed count as still owed, so the answer is never smaller than the cache can prove.
- Cycles are the month a bill falls due, the same convention `getBillSummary` uses.
- The purchase total is absent when the cache does not reach back to the first instalment. What is left to pay is still right, but what the purchase originally cost cannot be recovered from rows that were never cached.
- An estimated figure can land a centavo either side of the truth, because the last instalment of a plan is where the rounding goes.
- A card with no closing day stored and no bills published gets no final cycles, and the response says to call `setClosingDay`.

## 0.2.0: 2026-07-31

### Features

- **`getInvestments`**: a new tool listing the active investment positions held across your configured connections. Each position reports its institution, name, type, current balance and currency, plus quantity when the provider supplies one. Totals arrive grouped by currency and cover every selected position, not only the ones on the page you are reading.
- **`getInvestments`**: takes an optional `connectionId` to narrow the result to a single connection, and walks larger portfolios through a cursor at up to 100 positions per call.
- **`getInvestments`**: when one connection fails and others answer, the positions that did arrive still come back, and the failed connection is named under `unavailable`. If every selected connection fails, the tool says so rather than returning a zero, so an outage never reads as an empty portfolio.

### Notes

- Positions carry current value only. No cost basis, profit, return rate or asset allocation, and no currency conversion or combined total across currencies. Pluggy's fields for those are not comparable between position types, and a precise-looking wrong number is worse than no number at all.
- Fully withdrawn positions are hidden. Zero-valued positions that are still open stay visible.
- Releases now publish from GitHub Actions with npm provenance, so a published tarball can be traced back to the commit and the workflow run that built it.

## 0.1.2: 2026-07-29

### Bug Fixes

- **Configuration**: quotes, backticks and square brackets wrapped around a Pluggy environment variable are now trimmed off before the value is used. Pasting a credential with its surrounding punctuation still attached no longer fails validation.
- **`PLUGGY_ITEM_IDS`**: accepts semicolons and newlines as separators, in addition to commas.

## 0.1.1: 2026-07-29

### Bug Fixes

- **`getBillSummary`**: correctly identifies a locally configured card's open cycle by its due month when its closing and due dates cross a month boundary. The reported closing date and `posted`/`future` totals now describe the same bill.
- **`getBillSummary`**: when the closing day equals the due day, treats the due date as falling in the following month. Transactions stay in the current bill instead of moving into the future cycle.

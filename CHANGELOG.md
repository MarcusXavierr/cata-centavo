# Changelog

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

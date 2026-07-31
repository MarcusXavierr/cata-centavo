# Changelog

## 0.1.2: 2026-07-29

### Bug Fixes

- **Configuration**: quotes, backticks and square brackets wrapped around a Pluggy environment variable are now trimmed off before the value is used. Pasting a credential with its surrounding punctuation still attached no longer fails validation.
- **`PLUGGY_ITEM_IDS`**: accepts semicolons and newlines as separators, in addition to commas.

## 0.1.1: 2026-07-29

### Bug Fixes

- **`getBillSummary`**: correctly identifies a locally configured card's open cycle by its due month when its closing and due dates cross a month boundary. The reported closing date and `posted`/`future` totals now describe the same bill.
- **`getBillSummary`**: when the closing day equals the due day, treats the due date as falling in the following month. Transactions stay in the current bill instead of moving into the future cycle.

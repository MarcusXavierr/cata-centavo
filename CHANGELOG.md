# Changelog

## 0.1.1: 2026-07-29

### Bug Fixes

- **`getBillSummary`**: correctly identifies a locally configured card's open cycle by its due month when its closing and due dates cross a month boundary. The reported closing date and `posted`/`future` totals now describe the same bill.
- **`getBillSummary`**: when the closing day equals the due day, treats the due date as falling in the following month. Transactions stay in the current bill instead of moving into the future cycle.

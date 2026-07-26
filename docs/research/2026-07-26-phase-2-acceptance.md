# Phase 2 acceptance

Run on 2026-07-26 against the three configured Pluggy connections and six accounts. The MCP server ran under Node 24.15.0 with real credentials loaded from the shell profile. No statement payloads or transaction ids are recorded here.

## Results

- `getTransactions` for 2026-06-01 through 2026-06-30 returned `spent: 23169.31` and `received: 18919.72` in BRL, covering all six accounts.
- The immediate repeat returned the same totals and did not walk the connections again.
- The isolated cache-population run produced six walk log entries. Every entry reported `deleted: 0`. The repeat produced no walk entries.
- Filtering to the top-level supermarket category returned `spent: 1276.67`, `received: 0.00`, across 31 rows.
- `listTransactions` returned two bounded rows with a cursor. `getTransactionDetails` returned details for two selected rows, with decimal-string amounts and no Pluggy metadata blobs.
- `listTransactions` with `limit: 500` returned an `isError` tool result containing the validation message for the 100-row cap. The JSON-RPC response itself was not a top-level protocol error.
- Filtering to the top-level same-holder transfer category returned `spent: 0.00` and `received: 0.00` while retaining the transfer group. The unit suite also covers the `05100000` credit-card bill-payment leaf, which is excluded from headline totals while remaining visible in its group.

## Follow-up

The `deleted: 0` result is evidence from this run, not proof that Pluggy transaction ids are stable across every future re-sync. The open question remains open until a refresh changes the source data and a later walk can be compared.

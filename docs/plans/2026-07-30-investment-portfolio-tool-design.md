# Investment portfolio tool design

## Purpose

A caller who wants to inspect investments has no dedicated position view. `getAccounts` cannot represent provider investment positions because its current mapper accepts only `BANK` and `CREDIT` account types.

`getInvestments` will provide a paginated portfolio snapshot. It answers "what active positions do I hold, and what are they worth now?" It does not calculate returns, cost basis, taxes, allocation, or investment activity. Cash remains the answer to a balance question. Investments remain a separately labelled value.

This design relies on the provider endpoint and field semantics recorded in [the investment portfolio API research](../research/2026-07-30-investment-portfolio-api.md).

## Public tool

The MCP server registers `getInvestments` with this optional input:

```ts
{
  connectionId?: string,
  limit?: number, // 1-100, defaults to 100
  cursor?: string
}
```

Without `connectionId`, the tool returns positions for every configured connection. With it, the tool returns positions from that connection only. An unconfigured connection ID returns readable tool error content before any provider request.

The successful response has this shape:

```ts
{
  positions: [
    {
      id: string,
      connectionId: string,
      institution: string,
      name: string,
      type: string,
      subtype: string | null,
      balance: string,
      currency: string,
      quantity?: string
    }
  ],
  totals: [{ currency: string, balance: string }],
  totalPositions: number,
  hasMore: boolean,
  nextCursor: string | null,
  unavailable: [{ connectionId: string, kind: string, message: string }]
}
```

`balance` is a decimal string formatted from integer cents. `quantity` is a string when Pluggy supplies it, because it can be fractional and is not money. Positions sort by currency ascending, balance descending, institution, name, then position ID. Totals sort by currency. The tool does not convert currencies or create a cross-currency grand total.

Each response returns at most `limit` positions. `totalPositions` and `hasMore` explicitly say whether the page contains the whole selected portfolio. When another page exists, `nextCursor` contains the cursor for the same `connectionId` filter and sort order; otherwise it is `null`. Totals cover every selected active position, not only the current page. The live probe saw 21 positions across the configured connections, but the implementation still walks all provider pages before applying local pagination.

## Domain boundary

The implementation adds a separate `InvestmentPosition` type in `src/core/`. It contains only the identity, ownership, classification, current balance, currency, optional quantity and status information the tool needs. It does not extend `Account`: a portfolio position and a bank account have different fields and lifecycle semantics.

`Bank` gains `getInvestments(connectionId)`. The core investment collector receives only domain positions. A configured connection ID is the Pluggy Item ID already used by the client, so it passes directly as the endpoint's `itemId` parameter. The Pluggy client requests each page of `/investments` and maps provider values in `pluggy/mapper.ts` or an adjacent dedicated mapper.

The collector is dedicated to investments. It retains the account collector's concurrent `Promise.allSettled` shape but changes fulfilled-empty semantics: only a rejected request creates an unavailable entry, and a fulfilled empty array is a healthy connection with no active positions. A generic fetching framework would add indirection without another caller.

## Provider handling

For each selected connection, the Pluggy client requests `/investments` with `pageSize=500` and advances through the reported `totalPages`. A short page never terminates the walk. The first page and every later page must carry finite, non-negative integer `total` values, a positive integer `totalPages`, and the requested `page` number. Later pages must preserve the first page's `total` and `totalPages`; otherwise that connection fails with `bad-response`. Duplicate investment IDs across the walked pages also fail the connection rather than silently double-counting its portfolio.

Provider money is converted through the existing `toCents` policy, which rounds arbitrary provider precision half away from zero and rejects non-finite or unsafe values. The MCP formatter emits two-decimal strings, consistent with the project's existing monetary convention. This tool does not introduce a different currency minor-unit policy.

A position is hidden only when all conditions of the established liquidated-position rule hold:

```ts
status === "TOTAL_WITHDRAWAL" && balance === 0 && amount === 0
```

This rule avoids permanently showing fully withdrawn positions while preserving other zero-valued positions. The provider's nested `transactions` array is ignored. Pluggy documents that field as deprecated in favor of its investment-transactions endpoint, and it is unbounded. Investment activity is outside this tool.

V1 exposes current balance only. Pluggy fields such as `amount`, `amountProfit`, `annualRate` and `lastMonthRate` do not establish a single cost or performance definition that is comparable across position types. Publishing one as a return metric would give a precise-looking but misleading answer.

## Failure behavior

Connections fetch in parallel. A healthy connection contributes positions even when another connection fails. The response labels the failed connection in `unavailable`, which lets the caller distinguish a partial portfolio from a complete one. Logs record counts, selected connection IDs and outcomes only. They never include the full position payload.

A selected connection with no active positions is successful. Zero configured or selected connections likewise returns empty `positions`, `totals` and `unavailable` arrays. If at least one connection was selected and every selected connection request fails, the tool returns readable `isError` content and no totals. This avoids reporting zero investment value when data is unavailable.

## Acceptance tests

1. A caller with active positions across two connections receives a first page of no more than 100 positions, every-position totals separated by BRL and USD, and a cursor that reports the remaining positions.
2. A caller who continues with that cursor receives the next deterministic page. A cursor used with another `connectionId` filter is rejected as readable error content.
3. A caller who passes `connectionId` receives only that connection's positions and total. An unconfigured connection ID receives readable error content before any provider call.
4. A caller with no active positions, including zero configured connections, receives successful empty positions and totals rather than an error or a made-up zero balance.
5. When one connection fails and another succeeds, the caller receives the successful positions and an unavailable entry for the failed connection. When every selected connection fails, the tool returns readable error content.
6. An MCP client connected to the assembled server invokes `getInvestments` and observes the active-position response, proving registration, parsing, dependency composition and formatting together without requiring a live Pluggy credential.

Tests use the public MCP surface where possible. Pure mapper and collector tests cover cents rounding, the liquidated-position rule, provider page metadata, duplicate IDs, sort order and cursor boundary. Fakes remain at the external bank boundary.

## Non-goals

- Investment transactions, buys, sells, dividends and brokerage notes.
- Cost basis, profit, return rate, tax analysis and asset allocation.
- Currency conversion or a net-worth total.
- Changing `getAccounts` or `getBalance` semantics.

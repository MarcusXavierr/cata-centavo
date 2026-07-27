# Phase 4 acceptance

Run on 2026-07-27 against the three live credit cards through the read-only MCP tools. This record contains only aggregate totals, freshness fields, source enums and counts. It contains no account or transaction IDs, names or statement details.

## Results

| card | posted | committed | gap | utilization | `dataThrough` | `staleDays` | `closingDateSource` | `topCount` |
| --- | ---: | ---: | ---: | ---: | --- | ---: | --- | ---: |
| sandbox | 265.50 | 265.50 | 0.00 | 265.50 | 2026-07-14 | 9 | `open-bill` | 1 |
| live card B | 3887.98 | 6515.24 | 2627.26 | 9276.79 | 2026-07-23 | 3 | `last-closed` | 5 |
| live card C | 23.90 | 42.92 | 19.02 | 98.52 | 2026-07-14 | 12 | `last-closed` | 2 |

Card B moved since the 2026-07-26 targets. `posted` fell from 6046.52 to 3887.98, a delta of -2158.54. `committed` rose from 6409.34 to 6515.24, a delta of +105.90. Card C was unchanged at 23.90 and 42.92. The sandbox `posted` figure was unchanged at 265.50.

## Findings from the live run

The live `/bills` response omitted `accountId` and returned `allowsInstallments: null`. Both are valid provider shapes.

The sandbox's open bill had no closing date and had a future due date. A published bill in that shape is still the open cycle.

The sandbox rows also exposed why a published open-bill total must win over a row sum. The provider classified a positive payment as a purchase, so the rows netted to zero even though `/bills` published 265.50. `posted` now uses the published total when the provider includes the open cycle in `/bills`.

No live card returned an empty bill list. Normal empty-list behavior is covered only by the focused MCP test, `returns an empty bill list as a normal result`, in `tests/mcp/tools/bills.test.ts`. It is automated acceptance, not live evidence.

## Mutation limitation

The Task 14/19 mutation attempt instrumented 35 files and 2397 mutants, then created seven test runners. It stalled for more than two minutes with a defunct worker and executed no mutants, so the scoped Stryker process was terminated. This matches the three earlier environment stalls recorded in the ADR. Mutation testing is non-gating, and this run produced no mutation score.

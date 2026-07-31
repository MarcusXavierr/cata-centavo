# Instalment plans acceptance fixture

This note records the result of running the shipped derivation against the local cache on 2026-07-31. It gives a maintainer a small, public-safe oracle for deciding whether a later result is a regression or simply a newer cache.

## Snapshot and method

The local `cache.db` was opened read-only inside a SQLite read transaction. It was not copied, exported, or added to the repository. The snapshot contained 1,754 transaction rows. Its three connection-level `dataThrough` dates were 2026-07-14, 2026-07-24, and 2026-07-27.

The derivation ran on 2026-07-31 over every cached credit card, with the current `deriveInstalmentPlans` implementation. The configured bill endpoint was queried for all three cards before deriving. It returned 2, 12, and 12 published bills respectively, and each card resolved to an open due-month cycle of `2026-08`.

This is derived output, not a statement. The fixture contains only figures and merchant names already permitted by the instalment-plans design. It deliberately omits card, account, connection, transaction, and bill identifiers, plus every raw transaction row.

## Open plans

The run produced 12 open plans with R$ 6.330,87 still owed. Eleven are purchases and one is the annual-fee renewal. Money marked `estimated` includes a position that the cache has not materialized. A `derived` final cycle comes from an observed billing cadence rather than a bank-published final row.

| Merchant | Paid | Remaining | Money left | Final cycle | Evidence |
|---|---:|---:|---:|---|---|
| CP PARC DUO GOURMET | 1/2 | 1 | R$ 265,50 | 2026-08 | reported |
| AMAZON PRIME BR | 7/12 | 5 | R$ 69,50 | 2026-12 | amounts reported, cycle derived |
| ARAUJO LOJA | 2/3 | 1 | R$ 1.166,00 | 2026-08 | estimated, cycle derived |
| AIRBNB * HMJNKQKKPE | 1/2 | 1 | R$ 407,50 | 2026-08 | estimated, cycle derived |
| GPA BAR E RESTAURANTE | 1/2 | 1 | R$ 262,15 | 2026-08 | estimated, cycle derived |
| AIRBNB * HMNMZ2XMJF | 1/2 | 1 | R$ 245,50 | 2026-08 | estimated, cycle derived |
| VISAMUNDO | 2/3 | 1 | R$ 195,68 | 2026-08 | estimated, cycle derived |
| VINDI *CALCADOSTOFANI | 2/3 | 1 | R$ 131,24 | 2026-08 | estimated, cycle derived |
| PAGUEMENOS01232 | 0/2 | 2 | R$ 124,90 | 2026-09 | estimated, cycle derived |
| MERCADOLIVRE*MERCADOL | 0/2 | 2 | R$ 78,90 | 2026-09 | estimated, cycle derived |
| ANUIDADE DIFERENCIADA | 5/12 | 7 | R$ 385,00 | 2027-02 | estimated, cycle derived, renewal |
| AMAZON BR | 0/10 | 10 | R$ 2.999,00 | 2027-05 | estimated, cycle derived |

Every open plan was inspected against the design rules. The result contains the expected single-row MercadoLivre plan, keeps the annual fee as a renewal, and keeps the two zero-paid plans because their first positions are in the open cycle. The reversal rules did not create a phantom plan or remove a live one. The report also preserved the renamed Amazon plan as one plan, used the due-month convention for its `2026-12` finish, and did not use a forecast date as an absolute cycle.

## Drift from the earlier regression oracle

The backlog appendix's ten-plan total of R$ 5.853,07 is intentionally not the oracle for this snapshot. It predates the MercadoLivre plan and the annual fee. Adding those two known omissions yields 12 plans and R$ 6.316,97.

The observed total is R$ 13,90 higher, at R$ 6.330,87. The difference is one AMAZON PRIME BR instalment. Under the fresh bill list and the resolved `2026-08` open cycle, the derivation proves seven positions closed and treats the next position as open. It therefore reports five remaining positions and R$ 69,50, instead of the earlier appendix's four and R$ 55,60. This is snapshot and bill-state drift, not a grouping regression.

The annual-fee caveat is settled for this run. The configured bills identify the relevant July-closing statement as closed by 2026-07-31, so the derivation's R$ 385,00 over seven remaining positions is the applicable result. It is not the alternative R$ 440,00 over eight positions.

## Bank-app verification

No bank-app result is recorded. On 2026-07-31, the authorized browser context exposed no authenticated issuer app or statement page, so no card could be checked against the bank app without inventing evidence. The intended check is the Santander card: compare its open instalment plans and final due months with its issuer statement. The missing prerequisite is an authenticated, authorized browser session for that issuer's bank app with statement access. Local cache and configured-bill verification are complete; this external confirmation remains pending.

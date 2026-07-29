# The open cycle tag is a due month, including the `local` source — design

Written 2026-07-29, against issue #13.

## The defect

`identifyOpenCycle` has four sources and they did not agree on what the tag means. `open-bill`, `last-closed` and `due-date` derive it from a `dueDate`. `cycleFromStoredDay` derived it from the stored closing day, so it returned the month the cycle *closes* in.

The tag is consumed by `belongsToFutureCycle` in `core/bill-rows.ts`, which compares it against `billForecastDate`. Pluggy writes that field against a `Bill`, and a `Bill` is identified by its `dueDate`, so the due month is the convention the comparison needs. `docs/research/2026-07-26-open-bill-probe.md:46` shows it directly: the gold's open-cycle rows carry `fc=2026-08` while that cycle falls due 2026-08-15.

Indexing by closing month is also not available to every source. `due-date` holds only `creditData.balanceDueDate` and would need the card's closing-to-due interval to produce a closing month, which is stored nowhere. One convention has to serve all four, and the due month is the one all four can reach.

## Why it was invisible

The two conventions agree whenever a card closes and falls due in the same month. All three cards in the Phase 4 capture fall due on the 15th, so nothing in the evidence separated them.

They come apart on a card that closes late in one month and falls due early in the next, closing on the 25th and due on the 5th being the common shape. There the cycle closing 2026-07-25 falls due 2026-08-05 and is tagged `2026-08` by Pluggy and by the other three sources, while `cycleFromStoredDay` returned `2026-07` on any day before the 25th.

A tag one month early sends open-cycle rows into `futureRows`: `posted` underreports and `future` overreports. The `local` source is reached only when the connector publishes no bills, which `getBills` describes as normal on non-regulated connections, so the path is not exotic on the cards that depend on it.

## The change

`cycleFromStoredDay` now takes `balanceDueDate` and splits in two. `closingCycleFromStoredDay` keeps the existing behaviour unchanged, including the February clamp and the rule that a day landing on the closing day closes the cycle. `cycleFromStoredDay` then shifts that month forward when the due day precedes the closing day, because a card whose due day comes earlier in the month than its closing day falls due in the following month.

A due day equal to the closing day is treated as the same month. There is no interval to cross.

## The case with no due date

When `balanceDueDate` is `null` there is no closing-to-due interval anywhere in the data, and `setClosingDay` stores a closing day and nothing else. The closing month stands in that case, which is what the code did before this change.

That keeps the fix inside `core/bill.ts` with no API change and no data migration. Storing a due day alongside the closing day would remove the gap entirely, and is a separate change worth making only if this one leaves a card wrong in practice.

## Tests

`tests/core/bill.test.ts` gains the card that closes on the 25th and falls due on the 5th, before and after its closing day, plus the same-month card, the due day equal to the closing day, the year rollover under the shift, and the `null` due date falling back to the closing month.

Three existing expectations move, all from the same cause. The stored-day case at closing day 20 with a due date on the 15th becomes `2026-09`. The two February clamp cases inherit the fixture's default due day of the 15th against a stored day of 31, so they become `2027-04` and `2027-03`. What those two assert, that the 28th closes a clamped cycle and the 27th does not, is unchanged.

Mutation testing over `src/core/bill.ts` leaves no survivor in the new code. The survivors that remain sit in `billIsOpen`, `newestBill`, the clamp, and the leap-year helper, and all of them predate this change.

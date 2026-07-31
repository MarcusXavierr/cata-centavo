# [BE] One instalment grouping, used by getBillSummary too

**Type:** Task
**Priority:** Medium
**Tracker:** none (local markdown)
**Size:** 1-2 days
**Depends on:** ticket 01, which introduces `src/core/instalment-plans.ts`

## Context

`getBillSummary` needs to know how much of a card's instalment commitment has not been posted yet, so it can subtract that from utilized credit. `deriveImpliedCents` computes it by grouping the open cycle's rows on raw `description | instalmentTotal`, and its own docblock admits that key is safe only at that boundary: it works because a counter embedded in the description gives each instalment a distinct key, and because a normal plan posts one instalment per cycle. Ticket 01 builds real plan identity over a card's whole history, which makes the crude key unnecessary and its two heuristics removable.

The heuristic worth removing most is `trackInstalmentHistory`, whose docblock names its own false positive: two separate purchases sharing a description, where the first completed, zero out the second one's remainder. The identity rule from ticket 01 separates them by purchase instant, and by a counter that fails to advance when the instant is missing.

## Where to look

`deriveImpliedCents` and `addToOpenCyclePlans` in `src/core/bill-rows.ts` are the grouping to replace. `trackInstalmentHistory` and the `wrappedInstalmentRowIds` set that threads through `BillRowPartition` exist only to serve it, and should leave with it. `deriveBillCommitment` is the caller whose output must not move without an explanation.

## What needs to happen

Express the unposted commitment in terms of the plans ticket 01 derives, rather than re-grouping rows inside the cycle. Delete the grouping, the wrapped-counter tracking and the set that carries it.

The two figures are not the same question and must not be conflated. `listInstalmentPlans` answers what is still owed, counting an instalment posted into the open cycle as remaining. `impliedCents` answers what falls due after this cycle, counting that same instalment as already inside it. A card with `AMAZON BR` 1/10 at R$ 299,90 posted but unbilled owes ten instalments and implies nine. Both are right.

This change is gated on evidence, not on tests alone. Run both implementations over a real `cache.db`, print `impliedCents` per card before and after, and account for every difference in writing before switching. No difference means the refactor is clean. A difference is the old heuristic's false positive surfacing, and it has to be named and accepted deliberately, because `committed` is a number the user reads.

## Acceptance criteria

* `src/core/bill-rows.ts` no longer groups instalments; `deriveImpliedCents`, `addToOpenCyclePlans`, `trackInstalmentHistory` and `wrappedInstalmentRowIds` are gone, with no replacement grouping introduced elsewhere.
* `impliedCents` is derived from the same plan identity `listInstalmentPlans` uses, and the two figures still differ where they should: an instalment posted into the open cycle is remaining for the tool and not implied for the bill.
* Every per-card difference between the old and the new `impliedCents` on a real cache is written down and explained before the switch, and the finding lands in `docs/research/`.
* Two purchases sharing a description, where the first completed, no longer zero out the second one's remainder.
* The duplicated future-cycle predicate is gone. Ticket 01 reimplements `belongsToFutureCycle` as a private `isFutureRow` in `src/core/instalment-plans.ts` to keep the two modules independent for one release. Two copies of a rule that decides which cycle a row lands on is exactly the drift this ticket exists to remove, so unification collapses them to one and a test pins both callers to the same answer for the `"0001-01"` sentinel, a forecast equal to the open cycle, and a forecast beyond it.

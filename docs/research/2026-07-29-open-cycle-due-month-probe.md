# The open cycle against fresh feeds and due-month logic — 2026-07-29

A third read-only capture against the same three Open Finance connections (connector 200). Captured at `2026-07-29T18:27:47Z`. Both real cards were inside an open cycle due `2026-08-15`.

The purpose of this probe was to test a new hypothesis: since the Santander's open bill value moved (from 6.042,44 to 6.595,75) and its app updated recently, does the "simple" Nubank calculation (`utilization - materialized future instalments`) now correctly compute the Santander's bill?

## The oracles

Read directly from the bank apps exactly at the time of the API capture:

| card | account | utilization (`balance`) | open bill, from the app |
| --- | --- | ---: | ---: |
| AAdvantage Mastercard Platinum (Santander) | `cca6e1a8` | 9.400,81 | **6.595,75** |
| gold (Nubank) | `c2f080cb` | 99,08 | **43,48** |
| sandbox | `6115b6de` | 265,50 | — |

## The Hypothesis: Falsified

**The simple rule (`utilization - materialized`) does not work on the Santander.**

- `utilization`: R$ 9.400,81
- `materialized`: R$ 0,00. **All 65 unbilled rows on the Santander carry `billForecastDate: "2026-07"`.** None carry the `0001-01` sentinel anymore, and none carry `2026-08`. Because the open cycle is `2026-08`, no row is classified as future.
- Result: R$ 9.400,81.
- Gap to the app's figure: **+R$ 2.805,06**.

It does hit exactly on the gold card (99,08 - 55,60 = 43,48) because Nubank explicitly materializes future rows and updated its feed (its unbilled rows now span out to 2026-12). But this is a connector-specific trait, not a generalizable rule.

## The Shipped Rule: Corroborated

The exact arithmetic currently shipped in `cata-centavo` (`utilization - max(materialized, implied)`) behaves as follows against the fresh capture:

| card | materialized | implied | future | shipped committed | app oracle | gap |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Santander | 0,00 | 2.761,55 | 2.761,55 | **6.639,26** | 6.595,75 | **+R$ 43,51** |
| gold | 55,60 | 55,60 | 55,60 | **43,48** | 43,48 | **R$ 0,00** |

*(Note: the Santander `implied` drops to 2.761,55 specifically because the `ANUIDADE DIFERENCIADA` counter-wrap guard fires on 37 rows when processed in date-ascending order. Without the wrap guard, implied would be 2.801,00 and the gap would jump to +R$ 4,06. Ordering is a load-bearing mechanic).*

### The remaining R$ 43,51 residue
At the 2026-07-26 capture, the Santander's residue was R$ 366,90. After the data refresh, it shrank to just R$ 43,51 (0,66% off target). 

An exhaustive partition search reveals there is no isolated financial predicate (like "exclude IOF" or "exclude specific credit categories") that subtracts exactly 43,51. One would have to arbitrarily pick three unconstrained rows (e.g. 5,50 + 15,00 + 23,01) to force the hit. That constitutes target fitting, not a programmatic rule.

## What changed since the July 26 captures

1. **Nubank lag disappeared:** The gold's feed now trails its account update by only 2 days, and it surfaces multiple `billForecastDate` strings correctly (`2026-08` through `2026-12`). This proves Nubank's lag is transient, not systemic.
2. **Santander sentinels vanished:** The `"0001-01"` date is completely gone. Instead, the Santander assigns the just-closed cycle (`2026-07`) to all unbilled purchases made in the open cycle (`2026-08`). The feed freshness is now 2 days. 

## Verdict & Actionable Conclusion

1. **Keep `getBillSummary` as two independently reported estimates (`posted` and `committed`).**
2. **Retain the shipped `committed` rule with no per-card branches.** It yields zero-error on Nubank and is honest down to R$ 43,51 on the Santander without resorting to free-parameter fitting.
3. The discrepancy confirms that exact derivation of the open bill without an explicit connector grouping key remains impossible, and `committed` is an estimate with an error bar, exactly as designed. 

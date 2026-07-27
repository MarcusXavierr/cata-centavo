# Phase 1 endpoint probe

Probe run: 2026-07-26 against the three configured Pluggy connections. Raw response bodies were saved under `/tmp/cata-centavo-phase-1-probe-qfv4IS/` and are not part of the repository.

## Findings

- `GET /accounts?itemId=...&pageSize=500&page=1` returned HTTP 200 for all three connections. Each returned the offset-paginated envelope `{ total, totalPages, page, results }`, with two accounts, one page, and six accounts in total.
- `GET /investments?itemId=...` returned HTTP 200 for all three connections. Two connections returned 21 positions and one returned an empty `results` array. A returned position included `type`, `subtype`, `balance`, `amount`, `quantity`, `name`, `status`, and the other investment fields in the raw envelope. One observed position was `EQUITY` / `STOCK`; one fully withdrawn `FIXED_INCOME` / `CDB` position had `balance: 0` and `amount: 0`.
- `GET /loans?itemId=...` returned HTTP 200 for all three connections, with `total: 0`, `totalPages: 1`, and an empty `results` array for each.
- `GET /accounts/{id}` returned HTTP 200 for one account per connection. Every returned body carried `itemId`.
- `GET /items/{id}` returned HTTP 200 for all three connections. `lastUpdatedAt` is on the item response, not the account response used by the mapper. All three items reported `status: UPDATED`, `executionStatus: SUCCESS`, and `isOpenFinance: false` on their connectors.

## Credit balance sign

The credit balances are positive debt, not negative cash. Two cards match the independent limit calculation exactly:

| card | balance | creditLimit - availableCreditLimit | result |
| --- | ---: | ---: | --- |
| 1 | 265.50 | 265.50 | matches |
| 2 | 9170.89 | 9170.89 | matches |
| 3 | 79.50 | 3429.50 | does not match |

The third card is evidence that `creditLimit - availableCreditLimit` is not a reliable substitute for the account `balance` on this connector. The mapper must preserve the reported `balance` and must not silently replace it with the subtraction. The `disaggregatedCreditLimits` payload explains the observed value: the card has a `customizedLimitAmount` of 2100.00, an `availableAmount` of 2020.50 and a `usedAmount` of 79.50.

This also resolves an important vocabulary issue. The account `balance` is a provider-reported open/used card balance; it is not guaranteed to be the user's current invoice total. Pluggy's `/bills` product is the invoice-level source. A follow-up read-only request for this account returned 12 historical bill records, but the checked-in research intentionally does not contain their real amounts. Phase 1 therefore reports the provider account balance as `owed` and does not call it the current invoice; invoice selection belongs with the future bills/transactions phase.

## Monetary precision

The six account-level `balance` values, and every present `creditLimit` and `availableCreditLimit`, passed:

```text
Math.abs(value * 100 - Math.round(value * 100)) < 1e-6
```

The investment payload also contained a nested value with more than two decimal places, but that is outside the account-balance fields measured by this task.

## Account types

The distinct account `type` values were `BANK` and `CREDIT`. Each connection returned one of each.

## Questions answered

All five Task 0 questions are now answered: investments and loans both returned 200; credit balances are positive; direct account lookup returned 200 with `itemId`; account-level balance and credit-limit fields were cent-aligned; and the only account types observed were `BANK` and `CREDIT`.

## Fixture policy

The checked-in fixtures are anonymized copies of one BANK account and one CREDIT account. Names, amounts, account numbers, owners, tax numbers, ids and connection identifiers are synthetic. The credit fixture uses the first observed card, whose reported balance agrees with its limit subtraction, so mapper tests can assert the relationship without encoding the inconsistent third-card data.

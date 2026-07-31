# Research: Investment portfolio API

- **Slug:** `2026-07-30-investment-portfolio-api`
- **Date:** 2026-07-30
- **Status:** complete
- **Triggered by:** Brainstorming a dedicated investment portfolio tool.
- **Informed:** [`2026-07-30-investment-portfolio-tool-design.md`](../plans/2026-07-30-investment-portfolio-tool-design.md)

## Question

What investment-position data can a first portfolio snapshot tool safely expose from Pluggy, and which provider fields should remain outside the first release?

## Sources

### [List Investments](https://docs.pluggy.ai/reference/investments-list)
- **Authors / Org:** Pluggy
- **Type:** vendor doc
- **Published:** unknown
- **Accessed:** 2026-07-30
- **Relevance:** high
- **What this contributed:** Confirms that `GET /investments` is a paginated per-item endpoint and documents position identity, balance, currency, type, subtype, quantity, invested amount, rates, taxes, and status. It also records that the nested `transactions` field is deprecated in favor of a separate investment-transactions endpoint, supporting a bounded position-only first tool.

## Synthesis

A portfolio snapshot can be built from paginated investment positions without relying on the deprecated nested transactions array. The provider reports current balance, product classification, quantity, invested amount, status, and several return-related fields. A first tool should return only stable, user-readable position information and a per-currency total. Performance metrics require explicit semantic decisions because the provider exposes several distinct rate and profit fields that do not define one universally comparable return figure.

## Downstream uses

- [`2026-07-30-investment-portfolio-tool-design.md`](../plans/2026-07-30-investment-portfolio-tool-design.md)

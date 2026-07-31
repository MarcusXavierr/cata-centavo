# [BE] Transaction details drop the merchant identity Pluggy already sends

**Type:** Task
**Priority:** Medium
**Tracker:** none (local markdown)
**Size:** 2 days

## Context

Asked what a `MERCADOLIVRE*MERCADOL` charge actually bought, the server can only repeat the acquirer's string back. The item itself is out of reach and stays there: no product or basket data crosses Open Finance, and Pluggy's transaction body has no field for one. What is reachable, and what we throw away today, is who the counterparty was. Pluggy sends a `merchant` block with `businessName`, `cnpj` and `cnae` that never enters `wire.ts`, so Zod strips it before any other layer sees it, while `descriptionRaw` and `creditCardMetadata.cardNumber` survive the parse and then die in the mapper: `descriptionRaw` is where `PAG*DEIVYN LANCHES LTDA 03/12` lives, the legal name and instalment counter the cleaned `description` sands off.

## Where to look

`toTransaction` in `src/pluggy/transaction-mapper.ts` is where the two parsed-but-dropped fields are lost, and `TRANSACTION` in `src/pluggy/wire.ts` is where `merchant` has to start existing at all. The ADR's amendment at §12.1 measured coverage on 2026-07-26: `merchant` on 22.4% of 1751 rows with `cnpj` populated on every one of them, cards included, and `descriptionRaw` on 96.7%. That flatly contradicts the table directly above it, which still lists `merchant.cnpj` as coming back undefined.

## What needs to happen

Confirm the coverage first. That ADR number is aggregated across three connections and is five days stale, and if `merchant` comes back empty on this wallet today then two thirds of this ticket evaporates, while `descriptionRaw` and `cardNumber` stay worth doing on their own. A probe in the spirit of `docs/research/` answers it cheaply and belongs in the record either way.

Then carry the fields through the layers they already have a path for: wire schema, domain type, mapper, an `ALTER TABLE` migration shaped like the existing `{to: 3}` entry, the row codec, and `formatDetail`. `cache.db` is droppable, so a re-harvest backfills rather than a migration having to. Surface them on `getTransactionDetails`, which is already the "tell me everything about this row" tool and already bounded at 20 ids. `listTransactions` stays lean and does not get them.

Worth saying plainly for whoever picks this up: on a marketplace the CNPJ resolves to the platform, not the seller, so the Mercado Livre charge that prompted this ticket stays opaque. The payoff is on the ordinary rows, `VINDI *BASTTERCOM` and `CP PARC DUO GOURMET`, where an acquirer prefix turns into a company with a name.

## Acceptance criteria

* `getTransactionDetails` returns the merchant's business name, CNPJ and CNAE, the bank's raw description, and the card's last four digits, each omitted rather than blank when Pluggy sends nothing.
* A cache built before the change serves the new fields after one re-harvest, with no manual delete.
* Measured coverage for each new field is recorded per account type, and §12.1's table no longer claims `merchant.cnpj` comes back undefined.

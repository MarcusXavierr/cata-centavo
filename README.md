
<img width="375" height="375" alt="logo" src="https://github.com/user-attachments/assets/e990ea13-b266-4def-917f-afc15c1b4275" />


Cata-centavo is an MCP server that reads your Brazilian bank and credit card data through Pluggy's Open Finance connections, so an agent can answer questions about your own money. It also keeps a few local corrections for how transactions get categorized. It is for someone who already has a Pluggy account with banks linked in MeuPluggy — not a hosted product, not multi-user, just a server you run against your own credentials.

## What it does

**Accounts and balances**
- `getAccounts` — lists every account across your configured connections, with balances and credit card limits.
- `getBalance` — consolidated cash and credit-used figures across all connections, reported separately because they are not the same kind of number.
- `getBalanceByAccount` — the current figures and details for one account.

**Spending**
- `getTransactions` — totals spending and income over a date range, grouped by category.
- `listTransactions` — individual transactions over a date range, paged.
- `getTransactionDetails` — full details for a bounded set of transaction ids.

**Credit cards**
- `getBills` — closed credit card bills.
- `getBillSummary` — the current, still-open bill.
- `getInstallments` — instalment purchases reconstructed from card transaction metadata.
- `manageClosingDate` — records a card's closing day locally, for banks that do not report it.

**Categories**
- `setCategory` — corrects the category of specific transactions.
- `setCounterpartyCategory` — assigns a category to everyone a CPF or CNPJ identifies, backwards and forwards.

**Diagnostics**
- `listSources` — lists every configured connection with its sync status and consent state.

Each tool's exact parameters and return shape are published in its own MCP description — that is what a model actually reads, and it is the version that cannot drift out of sync with a signature. The four credit card tools are still being built on a parallel branch, so they are named here by capability only.

## Requirements

- Node 22.13 or newer. On Node 22 you get an `ExperimentalWarning` about SQLite on stderr at startup; on Node 24 you don't, because `node:sqlite` is stable there. Node 20 has no `node:sqlite` and cannot run this at all.
- A Pluggy account, with a client id and secret
- Bank connections already linked in MeuPluggy — this server does not create connections, only reads from ones that already exist

## Install and configure

Three environment variables, all required:

```
PLUGGY_CLIENT_ID        from your Pluggy dashboard
PLUGGY_CLIENT_SECRET    from your Pluggy dashboard
PLUGGY_ITEM_IDS         connection ids from MeuPluggy, separated by commas
```

An MCP client spawns this server as a subprocess and does not read your shell profile, so these need to go in the client's own configuration, in its `env` block:

```json
{
  "mcpServers": {
    "cata-centavo": {
      "command": "npx",
      "args": ["cata-centavo"],
      "env": {
        "PLUGGY_CLIENT_ID": "...",
        "PLUGGY_CLIENT_SECRET": "...",
        "PLUGGY_ITEM_IDS": "..."
      }
    }
  }
}
```

## Commands

- `cata-centavo` (no argument) — runs the MCP server over stdio.
- `cata-centavo init` — checks that the credentials and every configured connection are readable, and reports which ones are not.
- `cata-centavo doctor` — a fuller diagnosis: connection status, consent state, what is cached locally, and whether the learned categorization map has anything in it yet.

## Categories, and one asymmetry worth knowing about

Categories come from your provider while your plan includes transaction enrichment. Every sync copies them into `data.db`, which is never dropped, so they survive the day the enrichment stops and the day the cache is rebuilt.

Alongside that, the server learns which categories go with which CNPJs from your own transactions — but only from a CNPJ, never from a CPF, and only when that merchant's transactions actually agree. A CNPJ has a line of business. A CPF is a person, and guessing that everything you send your sister is a "transfer" would then be applied backwards over everything you ever sent her.

That learned map is built from your data, on your machine, and is not shipped with the tool — a CNPJ-to-category table is a line of somebody's bank statement. **So there is a real asymmetry: if you install this after your own enrichment has already stopped, the map starts empty and has nothing to learn from.** You still get merchant-code categorization on card purchases, plus whatever you correct by hand, and corrections apply retroactively. But you will be doing more of the work than someone who installed earlier.

Ask the agent to show you what is uncategorized and tell it what those merchants are; both kinds of correction stick.

## What it cannot see

- A bank linked in MeuPluggy whose UUID never reached `PLUGGY_ITEM_IDS` is invisible to this server. No endpoint lists the items on a Pluggy account, so this cannot be fixed in software — compare `doctor`'s list against the banks you know you linked.
- Freshness is Pluggy's schedule, not this server's. There is no "sync now": on-demand refresh is refused outright. One of the author's own three connections went three days without syncing while still reporting itself up to date, with nothing in the response explaining why.
- A credit card's `usedCredit` figure is not what the card owes this month. It mixes the current billing cycle with instalments that have not been charged yet, and will not match what a banking app shows.


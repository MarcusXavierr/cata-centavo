<div align="center">

<img src="https://github.com/user-attachments/assets/e990ea13-b266-4def-917f-afc15c1b4275" alt="cata-centavo" width="200" height="200">

# Cata-centavo
**Ask an agent about your own money.** Brazilian Open Finance data over [MCP](https://modelcontextprotocol.io), via [Pluggy](https://pluggy.ai).

<p>
  <a href="https://www.npmjs.com/package/cata-centavo"><img src="https://img.shields.io/npm/v/cata-centavo?logo=npm&logoColor=white&color=cb3837" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/cata-centavo"><img src="https://img.shields.io/npm/dm/cata-centavo?logo=npm&logoColor=white" alt="npm downloads"></a>
  <a href="https://github.com/MarcusXavierr/cata-centavo/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/MarcusXavierr/cata-centavo/ci.yml?branch=main&logo=githubactions&logoColor=white&label=CI" alt="CI"></a>
  <a href="https://github.com/MarcusXavierr/cata-centavo/blob/main/LICENSE"><img src="https://img.shields.io/github/license/MarcusXavierr/cata-centavo?color=blue" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D22.13-5FA04E?logo=nodedotjs&logoColor=white" alt="node >= 22.13">
  <img src="https://img.shields.io/badge/MCP-server-0A7CFF" alt="MCP server">
</p>

<a href="#tools">Tools</a> ·
<a href="#install">Install</a> ·
<a href="#commands">Commands</a> ·
<a href="#categories">Categories</a> ·
<a href="#what-it-cannot-see">Limits</a> ·
<a href="#license">License</a>

</div>

<!-- Replace the placeholder below with the real screenshot: drag the PNG into a new GitHub issue, copy the user-attachments URL it gives you, and paste it into src. -->
<p align="center">
  <img width="855" height="352" alt="image" src="https://github.com/user-attachments/assets/ee489a5c-1024-4a93-b476-32dec8f6cad6" />
</p>

---

Cata-centavo is an MCP server that reads your Brazilian bank and credit card data through Pluggy's Open Finance connections, so an agent can answer questions about your own money. It also keeps a few local corrections for how transactions get categorized. It is for someone who already has a Pluggy account with banks linked in MeuPluggy — not a hosted product, not multi-user, just a server you run against your own credentials.

## Tools

**Accounts and balances**
- `getAccounts` — lists every account across your configured connections, with balances and credit card limits.
- `getBalance` — consolidated cash and credit-used figures across all connections, reported separately because they are not the same kind of number.
- `getBalanceByAccount` — the current figures and details for one account.

**Spending**
- `getTransactions` — totals spending and income over a date range, grouped by category.
- `listTransactions` — individual transactions over a date range, paged.
- `getTransactionDetails` — full details for a bounded set of transaction ids.

**Credit cards**
- `getBills` — statements for one card, newest first.
- `getBillSummary` — the cycle still in progress, as two independent estimates rather than one invented number.
- `setClosingDay` — records a card's closing day locally, for banks that do not report it.
- `listClosingDays` — the closing days stored so far.
- `deleteClosingDay` — drops a stored closing day.

**Categories**
- `setCategory` — corrects the category of specific transactions.
- `setCounterpartyCategory` — assigns a category to everyone a CPF or CNPJ identifies, backwards and forwards.

**Diagnostics**
- `listSources` — lists every configured connection with its sync status and consent state.

Each tool's exact parameters and return shape are published in its own MCP description — that is what a model actually reads, and it is the version that cannot drift out of sync with a signature.

Instalment purchases do not have a tool of their own yet. Card transactions do carry instalment metadata, so `getTransactionDetails` will show it per transaction, but nothing reconstructs a purchase across its instalments.

## Install

You need:

- **Node 22.13 or newer.** On Node 22 you get an `ExperimentalWarning` about SQLite on stderr at startup; on Node 24 you don't, because `node:sqlite` is stable there. Node 20 has no `node:sqlite` and cannot run this at all.
- **A Pluggy account**, with a client id and secret.
- **Bank connections already linked in MeuPluggy.** This server does not create connections, only reads from ones that already exist.

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

## Categories

Categories come from your provider while your plan includes transaction enrichment. Every sync copies them into `data.db`, which is never dropped, so they survive the day the enrichment stops and the day the cache is rebuilt.

Alongside that, the server learns which categories go with which CNPJs from your own transactions — but only from a CNPJ, never from a CPF, and only when that merchant's transactions actually agree. A CNPJ has a line of business. A CPF is a person, and guessing that everything you send your sister is a "transfer" would then be applied backwards over everything you ever sent her.

That learned map is built from your data, on your machine, and is not shipped with the tool — a CNPJ-to-category table is a line of somebody's bank statement. **So there is a real asymmetry: if you install this after your own enrichment has already stopped, the map starts empty and has nothing to learn from.** You still get merchant-code categorization on card purchases, plus whatever you correct by hand, and corrections apply retroactively. But you will be doing more of the work than someone who installed earlier.

Ask the agent to show you what is uncategorized and tell it what those merchants are; both kinds of correction stick.

## What it cannot see

- A bank linked in MeuPluggy whose UUID never reached `PLUGGY_ITEM_IDS` is invisible to this server. No endpoint lists the items on a Pluggy account, so this cannot be fixed in software — compare `doctor`'s list against the banks you know you linked.
- Freshness is Pluggy's schedule, not this server's. There is no "sync now": on-demand refresh is refused outright. One of the author's own three connections went three days without syncing while still reporting itself up to date, with nothing in the response explaining why.
- A credit card's `usedCredit` figure is not what the card owes this month. It mixes the current billing cycle with instalments that have not been charged yet, and will not match what a banking app shows. `getBillSummary` answers that question instead, and it answers with a range rather than one number.

## License

MIT — see [LICENSE](https://github.com/MarcusXavierr/cata-centavo/blob/main/LICENSE).

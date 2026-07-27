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

Cata-centavo lets you ask an agent about your own money. Point it at your bank and credit card accounts and ask what you spent on food last month, how the current card statement is going, or where a strange charge came from.

You run it on your machine, against your own accounts, and the categories you correct stay there. There is no hosted version and nothing multi-user about it.

## Tools

**Accounts and balances**
- `getAccounts`: lists every account across your configured connections, with balances and credit card limits.
- `getBalance`: consolidated cash and credit-used figures across all connections, reported separately because they are not the same kind of number.
- `getBalanceByAccount`: the current figures and details for one account.

**Spending**
- `getTransactions`: totals spending and income over a date range, grouped by category.
- `listTransactions`: individual transactions over a date range, paged.
- `getTransactionDetails`: full details for a bounded set of transaction ids.

**Credit cards**
- `getBills`: statements for one card, newest first.
- `getBillSummary`: the cycle still in progress, as two independent estimates rather than one invented number.
- `setClosingDay`: records a card's closing day locally, for banks that do not report it.
- `listClosingDays`: the closing days stored so far.
- `deleteClosingDay`: drops a stored closing day.

**Categories**
- `setCategory`: corrects the category of specific transactions.
- `setCounterpartyCategory`: assigns a category to everyone a CPF or CNPJ identifies, backwards and forwards.

**Diagnostics**
- `listSources`: lists every configured connection with its sync status and consent state.

Each tool's exact parameters and return shape are published in its own MCP description, which is what a model actually reads and the one version that cannot drift out of sync with a signature.

Instalment purchases do not have a tool of their own yet. Card transactions do carry instalment metadata, so `getTransactionDetails` will show it per transaction, but nothing reconstructs a purchase across its instalments.

## Install

You need Node 22.13 or newer, and a Pluggy account with your banks already connected.

### Getting your Pluggy keys

The bank data comes from [Pluggy](https://pluggy.ai), the Open Finance provider that does the talking to the banks. Cata-centavo only reads connections that already exist, so make them first.



1. At [MeuPluggy](https://meu.pluggy.ai/en) create your account and connect to your banks
<img width="1530" height="617" alt="image" src="https://github.com/user-attachments/assets/15bde1c7-dfd9-4f9e-9f6b-e254522afd58" />

2. Then go to the other [Plug portal](https://pluggy.ai/) login and connect your MeuPlug accounts to the Demo app. Also copy your `PLUGGY_CLIENT_ID` and `PLUGGY_CLIENT_SECRET` from this page
<img width="1918" height="595" alt="image" src="https://github.com/user-attachments/assets/be7670e9-35fc-4ea3-98d3-115298cd488f" />

3. Then connect your MeuPluggy accounts, one by one into the Demo App 
<img width="1206" height="813" alt="image" src="https://github.com/user-attachments/assets/66402550-ebeb-43ba-962b-3d091242e807" />


4. And then copy the `PLUGGY_ITEM_IDS` one by one
<img width="1851" height="627" alt="image" src="https://github.com/user-attachments/assets/16fc1d2a-39b2-4531-9ae6-487ade128006" />


That gives you three values, all required:

```
PLUGGY_CLIENT_ID        from your Pluggy dashboard
PLUGGY_CLIENT_SECRET    from your Pluggy dashboard
PLUGGY_ITEM_IDS         connection ids, separated by commas
```

The plain way is to export them in your `.zshrc` or `.bashrc`, and on MCP configuration file put like `"PLUGGY_CLIENT_ID": "${PLUGGY_CLIENT_ID}"`. That leaves your keys in a file every shell reads. If you would rather not, `secret-tool` keeps them in your keyring and a small wrapper script can pull them out right before the server starts. Setups differ enough that it is worth pointing your agent at this page and asking it which one fits your machine.

After configuring this, run `npx cata-centavo doctor` to validate your environment variables are working fine 

<img width="894" height="191" alt="image" src="https://github.com/user-attachments/assets/adc2bb35-a161-4241-a33a-42846aa507a1" />


### Adding it to Claude Code

```bash
claude mcp add cata-centavo \
  -e PLUGGY_CLIENT_ID=... \
  -e PLUGGY_CLIENT_SECRET=... \
  -e PLUGGY_ITEM_IDS=... \
  -- npx -y cata-centavo
```

Drop the `-e` flags if the three variables are already exported in the shell you start Claude Code from, since the server inherits that environment.

Other clients take the same thing as JSON:

```json
{
  "mcpServers": {
    "cata-centavo": {
      "command": "npx",
      "args": ["-y", "cata-centavo"],
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

- `cata-centavo` (no argument): runs the MCP server over stdio.
- `cata-centavo init`: checks that the credentials and every configured connection are readable, and reports which ones are not.
- `cata-centavo doctor`: a fuller diagnosis, covering connection status, consent state, what is cached locally, and whether the learned categorization map has anything in it yet.

## Categories

Categories come from your provider while your plan includes transaction enrichment. Every sync copies them into `data.db`, which is never dropped, so they survive the day the enrichment stops and the day the cache is rebuilt.

Alongside that, the server learns which categories go with which CNPJs from your own transactions. Only from a CNPJ, never from a CPF, and only when that merchant's transactions actually agree. A CNPJ has a line of business. A CPF is a person, and guessing that everything you send your sister is a "transfer" would then be applied backwards over everything you ever sent her.

That learned map is built from your data, on your machine, and is not shipped with the tool, because a CNPJ-to-category table is a line of somebody's bank statement. **So there is a real asymmetry: if you install this after your own enrichment has already stopped, the map starts empty and has nothing to learn from.** You still get merchant-code categorization on card purchases, plus whatever you correct by hand, and corrections apply retroactively. But you will be doing more of the work than someone who installed earlier.

Ask the agent to show you what is uncategorized and tell it what those merchants are; both kinds of correction stick.

## What it cannot see

- A bank linked in MeuPluggy whose UUID never reached `PLUGGY_ITEM_IDS` is invisible to this server. No endpoint lists the items on a Pluggy account, so this cannot be fixed in software. Compare `doctor`'s list against the banks you know you linked.
- Freshness is Pluggy's schedule, not this server's. There is no "sync now": on-demand refresh is refused outright. One of the author's own three connections went three days without syncing while still reporting itself up to date, with nothing in the response explaining why.
- A credit card's `usedCredit` figure is not what the card owes this month. It mixes the current billing cycle with instalments that have not been charged yet, and will not match what a banking app shows. `getBillSummary` answers that question instead, and it answers with a range rather than one number.

## License

MIT. See [LICENSE](https://github.com/MarcusXavierr/cata-centavo/blob/main/LICENSE).

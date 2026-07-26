# Refreshing a Pluggy item on demand

Researched 2026-07-25 to answer one question: can we make `init` re-sync a connection instead
of only reporting how stale it is? Yes — `PATCH /items/{id}`. What follows is what the docs
actually say, what they contradict themselves about, and what they do not say at all.

## Sources

Appending `.md` to any `docs.pluggy.ai` URL returns markdown with the OpenAPI definition
inlined, which is where the exact schemas below come from. The page index is at
`https://docs.pluggy.ai/llms.txt`.

- `docs.pluggy.ai/reference/` — `items-update.md`, `items-retrieve.md`, `items-delete.md`,
  `items-send-mfa.md`, `items.md`, `auth-create.md`, `connect-token-create.md`
- `docs.pluggy.ai/docs/` — `item.md`, `item-lifecycle.md`, `updating-an-item.md`,
  `data-sync-update-an-item.md`, `authentication.md`, `rate-limits.md`, `rate-limits-of.md`,
  `real-time-balance.md`, `webhooks.md`
- `docs.pluggy.ai/recipes/polling-an-item-connectors-execution-status.md`
- `github.com/pluggyai/pluggy-node` — `src/types/item.ts`, `src/types/execution.ts`,
  `src/baseApi.ts`, `src/client.ts`, for the enum members the OpenAPI omits

## The endpoint

```
PATCH https://api.pluggy.ai/items/{id}
X-API-KEY: <apiKey>
```

Described as *"Triggers new syncronization for the Item, optionally updating the stored
credentials"* (their spelling), and *"The credentials are optional in this case, if they are
not provided, it will use the stored ones."* A 200 returns the whole Item.

Every field of the `UpdateItem` body is optional — there is no `required` array, and `{}` is a
documented example titled "Without updating credentials".

```json
{
  "parameters":   { "user": "user-ok", "password": "password-ok" },
  "clientUserId": "My User App Id",
  "webhookUrl":   "https://example.com/webhook",
  "products":     ["ACCOUNTS", "TRANSACTIONS"]
}
```

`products` accepts `ACCOUNTS`, `CREDIT_CARDS`, `TRANSACTIONS`, `PAYMENT_DATA`, `INVESTMENTS`,
`INVESTMENTS_TRANSACTIONS`, `IDENTITY`, `BROKERAGE_NOTE`, `MOVE_SECURITY`, `LOANS`.

Documented 400s: `MFA_PARAMERTER_WAS_ALREADY_USED_ERROR` (their typo) when an MFA token
repeats from the last execution, `CONNECTOR_REQUIRED_PARAMETER_VALIDATION_ERROR`,
`TOO_MANY_CONSECUTIVE_ERRORS` after five failing syncs, and
`TOO_MANY_CONSECUTIVE_LOGIN_FAILURES` after two login errors, which imposes a 15-minute
backoff and returns `data.canRetryAfterDate`.

## The 409 is the debounce

This is the finding the design rests on. Ask too soon and Pluggy refuses:

> `CLIENT_IS_UPDATING_BEFORE_ALLOWED_FREQUENCY` — "Client updates on this item are allowed at
> most every `{minUpdateFrequencyAllowedInHours}` hours. Last update was at `{lastUpdatedAt}`"

with `data.minUpdateFrequencyAllowedInHours` (example value 24). The minimum interval is
enforced server-side, per client, and the refusal carries the timestamp needed to explain it.
So the "debounce measured in hours" of ADR §11 does not need a local table: it already exists,
and the right move is to read a 409 as a successful *already fresh* rather than as a failure.

New client IDs are throttled harder still: *"The updates could not be performed more than once
per hour."* Widget-driven updates are exempt; support lifts it for production apps.

## Polling

There is no completion webhook we use, so poll `GET /items/{id}`. Pluggy's own recipe:

```js
let item = await client.fetchItem(itemId)
while (item.status === 'UPDATING') {
  await sleep(2000)   // "wait a few seconds before next request (to prevent 429 error response)"
  item = await client.fetchItem(item.id)
}
```

`status === 'UPDATING'` is the loop condition and everything else is terminal — worth copying
exactly, because it means an unrecognised status ends the loop instead of spinning forever.
`executionStatus` is the finer-grained progress signal underneath it.

The 2000 ms comes from that example, not from a stated recommendation, and no rate limit is
published for `GET /items/{id}`. The only timing figure anywhere is a warning that
`LOGIN_IN_PROGRESS` alone *"could take up to 5 minutes, so please consider this time window in
your implementation."* Total duration is never stated.

## Statuses

**The OpenAPI schema types both `status` and `executionStatus` as bare `string` with no enum**,
and the prose docs disagree with the SDK about membership. Treat both as open unions.

`status`, per `item-lifecycle`: `UPDATING`, `UPDATED`, `LOGIN_ERROR`, `OUTDATED`,
`WAITING_USER_INPUT`. The SDK adds `WAITING_USER_ACTION` and `MERGING`, which the docs never
mention. And `rate-limits-of` shows a payload with `"status": "PARTIAL_SUCCESS"`, which appears
in neither list — while `statusDetail`'s own docstring says it is populated when the status is
`PARTIAL_SUCCESS`.

`executionStatus` — in progress: `CREATED`, `LOGIN_IN_PROGRESS`, `LOGIN_MFA_IN_PROGRESS`,
`ACCOUNTS_IN_PROGRESS`, `CREDITCARDS_IN_PROGRESS`, `TRANSACTIONS_IN_PROGRESS`,
`PAYMENT_DATA_IN_PROGRESS`, `IDENTITY_IN_PROGRESS`, `INVESTMENT_TRANSACTIONS_IN_PROGRESS`,
`MERGING`. Terminal success: `SUCCESS`, `PARTIAL_SUCCESS`. Terminal error: `ERROR`,
`MERGE_ERROR`, `INVALID_CREDENTIALS`, `ALREADY_LOGGED_IN`, `SITE_NOT_AVAILABLE`,
`INVALID_CREDENTIALS_MFA`, `USER_INPUT_TIMEOUT`, `ACCOUNT_LOCKED`, `ACCOUNT_NEEDS_ACTION`,
`USER_NOT_SUPPORTED`, `ACCOUNT_CREDENTIALS_RESET`, `CONNECTION_ERROR`,
`USER_AUTHORIZATION_NOT_GRANTED`, `USER_AUTHORIZATION_REVOKED`. Intermediate:
`WAITING_USER_INPUT`, and `USER_AUTHORIZATION_PENDING`, which resolves itself minutes later
with no client action.

The SDK adds `CREATING`, `CREATE_ERROR`, `WAITING_USER_ACTION`, `INVESTMENTS_IN_PROGRESS`,
`LOANS_IN_PROGRESS`, `ACCOUNT_STATEMENTS_IN_PROGRESS`, and spells one member
`INVESTMENTS_TRANSACTIONS_IN_PROGRESS` where the docs write
`INVESTMENT_TRANSACTIONS_IN_PROGRESS`. Which one the API emits is unresolved, so our stage
table carries both.

One outright doc bug: `updating-an-item` says "Item status: `INVALID_CREDENTIALS`". That is an
`executionStatus`, not a `status`.

## MFA

A connector needing a second factor lands in `status: WAITING_USER_INPUT` with `parameter`
populated:

```json
{ "status": "WAITING_USER_INPUT", "executionStatus": "WAITING_USER_INPUT", "lastUpdatedAt": null,
  "parameter": { "name": "token", "label": "Chave de segurança", "type": "string",
                 "placeholder": "Exemplo: 123456", "expiresAt": "2022-12-14T19:09:08.780Z" } }
```

Answer with `POST /items/{id}/mfa`, keyed by `parameter.name`: `{"token": "123456"}`. Two
shapes exist — a one-step connector wants the token inside the `PATCH` body itself and rejects
a repeat of the last execution's token; a two-step connector wants the `PATCH` first, then the
`/mfa` call once polling reaches `WAITING_USER_INPUT`.

So a terminal CLI *could* handle MFA by prompting on a TTY; no widget is required. What it
cannot do headlessly is anything in `LOGIN_ERROR` / `INVALID_CREDENTIALS`, where the docs are
explicit that new credentials must go through Pluggy Connect. Same for the institutions called
out as never auto-syncable — XP, Bradesco, Easynvest — where *"the only option for the Item to
be updated, is to have the User open Pluggy Connect."* Nubank and Banco do Brasil PJ become
auto-syncable only after an initial device authorization.

## What an update actually refreshes

The lookback per sync is 4–5 calendar days for Direct connectors and 7 calendar days including
today for regulated Open Finance ones. Item creation pulls up to 365 days.

But for Open Finance connectors **not every product refreshes on every update**. From
`rate-limits-of`, per CPF/CNPJ per institution per month:

| Product | Monthly quota | Refreshed |
|---|---|---|
| Account list and details | 4 | creation, then every 7 days |
| Account balance | 420 | every update |
| Transactions 1–6 days old | 240 | every update |
| Transactions 7–365 days old | 4 | creation, then every 7 days |
| Credit card list and details | 4 | creation, then every 7 days |
| **Credit card bills and bill transactions** | **30** | creation, then **once per day** |
| Credit card limits | 240 | every update |
| Investment list | 30 | creation, then once per day |
| Investment balance and recent transactions | 120 | every update |
| Identity | 4 | creation, then every 7 days |
| Loans list and detail | 4 | creation, then every 7 days |
| Loan instalments and payments | 30 | creation, then once per day |

Running `init` twice in an hour therefore buys fresher balances and recent transactions, and
nothing else. Credit card bills — the thing this project exists to read — move once a day no
matter what we do. A second item for the same CPF and institution burns the same shared quota
twice.

Exhausting a quota is not an error. It comes back as `PARTIAL_SUCCESS` with the detail in
`statusDetail`, which is why those warnings have to reach the user:

```json
{ "status": "PARTIAL_SUCCESS",
  "statusDetail": { "accounts": { "isUpdated": false, "lastUpdatedAt": "2023-10-19T19:19:58.188Z",
      "warnings": [{ "code": "423", "message": "Open Finance monthly rate limit reached on product 'accounts' for this CPF/CNPJ and institution. The product could not be updated." }] } } }
```

## Rate limits

`PATCH /items` is **20 requests per minute per IP**, against 360/min for `POST /auth` and the
data endpoints — an order of magnitude tighter, and the reason the client needs a second
window rather than one shared one. The note attached to it: *"This is meant for users'
triggered updates. If you need item updates on a daily basis, you must use our auto-sync
feature."* A 429 carries `RateLimit-Limit`, `RateLimit-Reset` and `Retry-After`, the last
always 60.

Auto-sync already runs every 24, 12 or 8 hours depending on subscription, on production
applications only, with `nextAutoSyncAt` on the Item as the earliest next run. A `LOGIN_ERROR`
stops it permanently until the connection is re-authorized; other errors retry hourly five
times and then drop the item from auto-sync altogether.

Batch processes are prohibited outright: *"the sync process is owned and maintaned by Pluggy"*
and *"batch update process will be mitigated and should never be created."* Ours fires only
when a human runs `init`, which is the distinction that keeps us on the right side of this.

## Two related endpoints

There is **no `GET /items` list endpoint, deliberately**: *"Listing existing connections its
not provided due to security reasons. We request all our customers to track all their
connections in the datasource referencing the `itemId` of Pluggy."* Confirmed three ways — the
reference lists only create, retrieve, update, delete and send-MFA; `llms.txt` has no entry;
the SDK has `fetchItem` but no `fetchItems`. Whatever we do about configuration, the ids are
ours to keep.

`GET /accounts/{id}/balance` fetches a balance straight from the institution without a full
item sync, for Open Finance connectors, sharing the same quota as a full execution. Worth
remembering for Phase 1. Its example returns the balance as a JSON **number** (`1500.50`),
which collides with our no-money-through-a-`number` rule, so that one needs parsing from raw
text rather than `JSON.parse`.

## Auth, confirmed

`POST /auth` with `{clientId, clientSecret}` returns `{apiKey}`. Header name is `X-API-KEY`,
from the OpenAPI `securitySchemes` and the SDK both. TTL is stated outright: *"This API key
expires after 2 hours."* The key is a JWT with an `exp` claim, which is why reading `exp`
beats tracking a timer — already what `client.ts` does.

Connect tokens use the same header but are scoped to `GET /items/:id` and
`GET /accounts?itemId` only, 403 on anything else, so they are no use server-side.

## Connector 200 refuses to be updated at all

Added 2026-07-26, after `init` failed against the real API on the only connection we have.

```
PATCH /items/2fdf412c-…  →  400
{ "message": "MeuPluggy item cant be updated", "code": 400, "errorId": "9999f635-…" }
```

The item is healthy: `GET /items/{id}` returns it `UPDATED` / `SUCCESS`. This is a refusal by
connector capability, not by item state, and no request we can construct gets past it.

**There is no structured signal for it, anywhere.** Three places to look and three misses:

- **The error body.** No `codeDescription`, and `code` is the HTTP status echoed back rather
  than a symbolic one. Every documented 400 on `reference/items-update.md`
  (`MFA_PARAMERTER_WAS_ALREADY_USED_ERROR`, `CONNECTOR_REQUIRED_PARAMETER_VALIDATION_ERROR`,
  `TOO_MANY_CONSECUTIVE_ERRORS`, `TOO_MANY_CONSECUTIVE_LOGIN_FAILURES`) carries one. This
  refusal is documented nowhere, under no code, in no page reachable from `llms.txt`.
- **The connector object.** `GET /connectors/200` returns `hasMFA`, `oauth`, `health`,
  `isOpenFinance`, `isSandbox`, `type`, `products`, and five `supports*` booleans — every one
  of them about payments. Nothing about updates. `pluggy-node/src/types/connector.ts` agrees:
  no `supportsManualUpdate`, no equivalent, and its `ConnectorFilters` cannot query for one.
- **The item object.** `nextAutoSyncAt` is documented as "the date when the next Pluggy's
  auto-sync update will be attempted (**if item is updatable**)", which is the closest the API
  comes to admitting the concept exists. It is not a capability flag: ours is `null`, and so is
  the undeclared `autoSyncDisabledAt` sitting beside it.

So `pluggy/wire.ts` matches the sentence, in one exported predicate, covering "cant", "can't"
and "cannot". It is the only string matching against Pluggy prose in the codebase and it should
stay that way.

## What Connector 200 actually is (ADR Phase 0.5 step 2)

`GET /connectors/200`, live on 2026-07-26:

```json
{ "id": 200, "name": "MeuPluggy", "type": "PERSONAL_BANK", "country": "BR",
  "institutionUrl": "https://meu.pluggy.ai/", "imageUrl": ".../connector-icons/sandbox.svg",
  "isOpenFinance": false, "isSandbox": false, "oauth": true, "hasMFA": false,
  "credentials": [], "health": { "status": "ONLINE", "stage": null } }
```

**Neither regulated nor Direct: it is Pluggy's own aggregator.** It declares
`isOpenFinance: false`, so it is not a regulated Open Finance connector; it asks for no
credentials at all, so it is not scraping a bank the way a Direct connector does. `oauth: true`
with `institutionUrl` pointing at `meu.pluggy.ai` is the whole story — the human logs into
Pluggy's own end-user app, links their banks *there*, and our item reads whatever MeuPluggy
holds. The Open Finance connection exists, one level down, where we cannot see it.

Three consequences, all of them narrowing what this project can know:

- **`item.connector.name` is `"MeuPluggy"`, never the institution** (Phase 0.5 step 6). The
  real bank's name is not on the item. Anything §10 wants to denormalize as `source` has to
  come from the accounts, not from here.
- **The lookback window and the monthly quota table above describe the layer beneath us.** The
  7-day regulated window and the 4-per-month credit-card-detail quota belong to the connections
  made inside MeuPluggy. Ours reports `isOpenFinance: false` and refuses updates outright, so
  neither figure is ours to reason about, and freshness cannot be predicted from either.
- **No on-demand refresh, and no auto-sync visible either.** `nextAutoSyncAt: null` on an item
  whose `lastUpdatedAt` was two days old. The auto-sync every 24/12/8h is documented for
  production applications only, so on this tier "Pluggy syncs it on its own schedule" is the
  documented mechanism, not something the item payload confirms. Worth a question to support:
  what does move `lastUpdatedAt` on a connector-200 item?

## Not confirmed

- **Whether an update is individually billable.** There is no pricing, billing or quota page
  anywhere in `llms.txt` — zero hits for plan, subscription, price, billing or usage. The only
  cost signal is qualitative: updating an item is *"a much more cost-efficient process"* than
  creating one. This needs a question to Pluggy support, not a guess.
- **Our actual `minUpdateFrequencyAllowedInHours`.** Per-client configuration; 24 is only the
  example in the 409 sample. We will learn ours the first time we hit it.
- **Enum membership for `status` and `executionStatus`,** as above.
- **`nonExpiring` on `POST /auth`.** The SDK sends `{clientId, clientSecret, nonExpiring: false}`
  and the OpenAPI documents no such field. A long-lived key mode is implied and undocumented.

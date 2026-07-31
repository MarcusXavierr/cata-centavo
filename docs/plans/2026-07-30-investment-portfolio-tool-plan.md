# Investment portfolio tool implementation plan

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task.

**Goal:** Add a paginated `getInvestments` MCP tool that lists active provider positions, totals their current value by currency, and makes partial connection coverage explicit.

**Architecture:** Add an investment domain model and collector in `core/`, then extend the existing `Bank` contract and Pluggy adapter with a strictly validated `/investments` page walk. The MCP tool applies deterministic local sorting and cursor pagination after it has collected the full selected portfolio, so each response has complete totals but no more than 100 position rows.

**Tech Stack:** Node 24 native TypeScript stripping, Zod, MCP SDK, `node:test`, Pluggy HTTP client, integer cents.

**Constraint:** Do not add dependencies. Do not commit unless the user explicitly asks. Run `nvm use` before every Node command.

---

## Acceptance tests

```gherkin
Scenario: Page a complete portfolio
  Given two configured connections provide 101 active positions across BRL and USD
  When a caller requests getInvestments with the default page size
  Then the response has 100 deterministically ordered positions
  And its per-currency totals cover all 101 positions
  And totalPositions is 101, hasMore is true, and nextCursor is present

Scenario: Continue the same portfolio query
  Given a getInvestments response has a nextCursor
  When the caller requests the next page with that cursor and the same connection filter
  Then the response contains the remaining positions without duplicates
  And hasMore is false and nextCursor is null

Scenario: Limit the portfolio to one connection
  Given configured connections contain positions in different institutions
  When a caller supplies one configured connectionId
  Then the response contains only positions from that connection
  And an unconfigured connectionId returns readable error content before provider access

Scenario: Distinguish empty data from failed data
  Given a configured connection returns no active positions
  When a caller requests getInvestments
  Then the response is a successful empty portfolio

Scenario: Preserve a partial portfolio
  Given one selected connection fails and another returns active positions
  When a caller requests getInvestments
  Then the successful positions and totals are returned with an unavailable entry
  And when every selected connection fails, the tool returns readable error content
```

## Task 1: Add the investment core model and collector

**Files:**
- Create: `src/core/investment.ts`
- Create: `tests/core/investment.test.ts`
- Modify: `src/core/contracts.ts:103-118`
- Modify: `tests/fakes/fake-bank.ts:1-121`
- Modify: `tests/fakes/fake-source.ts:13-68`

**Step 1: Write failing core tests**

Create `tests/core/investment.test.ts`. Use an exported `investmentPosition()` test fixture from `tests/fakes/fake-bank.ts` and table-driven cases for these observable collector results:

- a fulfilled empty connection produces no position and no unavailable entry;
- a rejected connection produces `{ connectionId, ...toFailure(error) }` while another connection’s positions survive;
- all selected rejections leave an empty position list and one unavailable item per selected connection;
- zero selected connections return both arrays empty.

Add a small sort-and-summary test table for BRL/USD totals and the full comparator: currency ascending, balance cents descending, institution, name, then ID. Include equal balance, institution and name cases that prove ID tie-breaking. The tests should import `collectInvestments`, `compareInvestmentPositions`, `sortInvestments`, and `summarizeInvestments` from the new core module. Use the comparator to prove a cursor tuple is strictly after the prior row. Do not test `Promise.allSettled` calls or fake call counts.

**Step 2: Run the core test to verify RED**

Run:

```bash
nvm use && node --test tests/core/investment.test.ts
```

Expected: the new module cannot be imported, or the requested exports do not exist.

**Step 3: Define the contract and minimal core implementation**

In `src/core/investment.ts`, define the domain type with only provider-independent fields:

```ts
export type InvestmentPosition = {
  readonly id: string;
  readonly connectionId: string;
  readonly institution: string;
  readonly name: string;
  readonly type: string;
  readonly subtype: string | null;
  readonly balanceCents: number;
  readonly currency: string;
  readonly quantity: string | null;
};
```

Add `CollectedInvestments`, `collectInvestments`, `compareInvestmentPositions`, `sortInvestments`, and `summarizeInvestments`. `collectInvestments` uses `Promise.allSettled` over `bank.getInvestments(connectionId)`. Only a rejected promise enters `unavailable`; a fulfilled empty array is healthy. `compareInvestmentPositions` implements the binding five-field ordering. `sortInvestments` returns a copy using that comparator. `summarizeInvestments` groups integer cents by currency and emits ascending-currency totals.

Extend `Bank` with:

```ts
getInvestments(connectionId: string): Promise<readonly InvestmentPosition[]>;
```

Extend `FakeBankOptions` with an `investments` map, add the matching fake method, and export `investmentPosition(id, overrides)` beside `account()`. The fake method validates connection ownership using the existing `answer` helper, honors `unreachable`, and returns `[]` for a configured connection without positions. Extend `FakeSourceOptions` with `investments` and forward it to `fakeBank`, so tool and assembled-server tests can configure positions through `fakeSource`.

**Step 4: Run the core test to verify GREEN**

Run:

```bash
nvm use && node --test tests/core/investment.test.ts
```

Expected: every core investment case passes.

**Step 5: Refactor only after GREEN**

Keep the unavailable type shared with `core/accounts.ts` if its current structural type is sufficient. Do not generalize account and investment collection: their empty-result meanings differ.

## Task 2: Parse and map Pluggy investment positions

**Files:**
- Modify: `src/pluggy/wire.ts:86-122`
- Modify: `src/pluggy/mapper.ts:1-75`
- Modify: `tests/pluggy/wire.test.ts`
- Modify: `tests/pluggy/mapper.test.ts`

**Step 1: Write failing wire and mapper tests**

Add an `investmentBody()` fixture to the existing Pluggy tests. Test that the new investment page schema accepts the observed required identity and valuation fields, tolerates omitted/null optional subtype, quantity and amount fields, and drops the deprecated nested `transactions` array.

Add a table-driven liquidation matrix that asserts a position is dropped only for `status === "TOTAL_WITHDRAWAL"`, `balance === 0`, and `amount === 0`. Cover zero, nonzero, null and omitted amounts under `TOTAL_WITHDRAWAL`, then a zero balance with another status. In the same table body, retain a normal position case that maps its provider balance through `toCents`, uses connection identity and institution, and serializes a numeric quantity without using it as money. Add a separate case that invalid/non-finite balance is rejected by the existing money guard.

**Step 2: Run the focused Pluggy tests to verify RED**

Run:

```bash
nvm use && node --test tests/pluggy/wire.test.ts tests/pluggy/mapper.test.ts
```

Expected: failures because `INVESTMENT`, `INVESTMENT_PAGE`, or `toInvestment` do not exist.

**Step 3: Add the schema and mapper**

In `src/pluggy/wire.ts`, add an `INVESTMENT` Zod schema and `INVESTMENT_PAGE` offset envelope. Require `id`, `name`, `balance`, `currencyCode`, and `type`. Make `subtype`, `quantity`, `amount`, and `status` nullish. Do not include `transactions` in the schema, so it is dropped with other unused provider fields.

Export the inferred wire type. In `src/pluggy/mapper.ts`, add:

```ts
export function toInvestment(investment: WireInvestment, connection: Connection): InvestmentPosition | null
```

The mapper returns `null` only for the three-part liquidated-position rule. Otherwise it maps `balance` with `toCents`, uses `connection.id` as `connectionId`, uses `connection.institution`, converts non-null quantity to its decimal string representation, and normalizes absent subtype to `null`.

**Step 4: Run the focused Pluggy tests to verify GREEN**

Run:

```bash
nvm use && node --test tests/pluggy/wire.test.ts tests/pluggy/mapper.test.ts
```

Expected: the new mapping cases and existing Pluggy tests pass.

**Step 5: Refactor only after GREEN**

Keep the liquidated rule in the provider mapper, where raw `amount` and `status` still exist. Do not add these provider-only fields to the core position.

## Task 3: Fetch every provider investment page with integrity checks

**Files:**
- Modify: `src/pluggy/client.ts:1-180`
- Modify: `tests/pluggy/client.test.ts`

**Step 1: Write failing client tests**

Add `investmentBody()` and `investmentPage()` helpers to `tests/pluggy/client.test.ts`. Use the existing fake fetch harness to test public `client.getInvestments(connectionId)` behavior:

- it requests page 1 with `itemId`, `pageSize=500`, then every reported later page and returns mapped active positions;
- it fetches the item concurrently so output includes the connection institution;
- it ignores a liquidated position after mapping;
- it rejects a page whose `page` does not equal the requested page, whose `total` or `totalPages` changes after page 1, or whose metadata is non-integral or invalid;
- it rejects duplicate investment IDs across pages;
- it does not stop when a page contains fewer rows than `pageSize`.

Use a table for the malformed-metadata cases. Assert requests and returned values, not internal helper calls.

**Step 2: Run the client test to verify RED**

Run:

```bash
nvm use && node --test tests/pluggy/client.test.ts
```

Expected: `getInvestments` is missing from the `Bank` implementation.

**Step 3: Implement the client page walker**

Import the new wire schema and mapper into `src/pluggy/client.ts`. Add a focused investment walker that:

1. starts the item request and first `/investments?itemId=<connectionId>&pageSize=500&page=1` request together;
2. validates page metadata before using it;
3. requests pages `2..totalPages` and validates their page number plus stable `total` and `totalPages`;
4. uses a `Set` to reject duplicate IDs before mapping;
5. filters `null` results from `toInvestment`.

The configured `connectionId` is already the provider Item ID. Do not introduce a second lookup or an `itemId` field into core. Include the requested page and connection ID in `ResponseShapeError` messages.

**Step 4: Run the client test to verify GREEN**

Run:

```bash
nvm use && node --test tests/pluggy/client.test.ts
```

Expected: all client tests, including existing account, transaction and bill tests, pass.

**Step 5: Refactor only after GREEN**

Extract a small metadata validator only if it keeps the offset-page invariant readable. Do not retrofit accounts or bills in this feature.

## Task 4: Add a cursor scoped to the investment query

**Files:**
- Create: `src/mcp/investment-cursor.ts`
- Create: `tests/mcp/investment-cursor.test.ts`

**Step 1: Write failing cursor tests**

Create tests for a round trip with this ordering position:

```ts
{ currency: "BRL", balanceCents: 12_345, institution: "Nubank", name: "CDB", id: "position-1" }
```

Test malformed base64url/JSON, missing or incorrectly typed fields, unsafe integer balance, and a cursor reused with a different `connectionId` filter. The decoded result must be a readable invalid-cursor result, not a throw.

**Step 2: Run the cursor test to verify RED**

Run:

```bash
nvm use && node --test tests/mcp/investment-cursor.test.ts
```

Expected: the cursor module is missing.

**Step 3: Implement the narrow cursor codec**

Copy the defensive parsing approach from `src/mcp/cursor.ts`, but keep a dedicated `InvestmentCursorPosition` and a filter fingerprint containing only `connectionId: string | null`. Encode the full position tuple, including `balanceCents` and ID, so equal balances and names cannot skip or repeat a row. Exclude `limit` from the fingerprint so callers may choose a new page size while continuing the same selected portfolio.

**Step 4: Run the cursor test to verify GREEN**

Run:

```bash
nvm use && node --test tests/mcp/investment-cursor.test.ts
```

Expected: valid cursors round-trip; every malformed or mismatched cursor becomes a readable invalid result.

**Step 5: Refactor only after GREEN**

Do not generalize `src/mcp/cursor.ts`. Transaction cursors carry date-specific behavior, while investment cursor ordering needs a different tuple.

## Task 5: Implement the paginated MCP tool

**Files:**
- Create: `src/mcp/tools/investments.ts`
- Create: `tests/mcp/tools/investments.test.ts`
**Step 1: Write failing MCP tool tests**

Create `tests/mcp/tools/investments.test.ts`, because this is a new registered tool rather than another account response. Reuse `fakeSource`, `fakeLogger`, `fakeBank`, `connection`, and the exported `investmentPosition` fixture. Follow the existing file-local `payload`, `message`, and dependency-helper pattern from other MCP tool tests rather than importing helpers that are not exported.

Test through `handleGetInvestments`:

- 101 positions return 100 sorted rows, full BRL/USD totals, `totalPositions: 101`, `hasMore: true`, and a non-null `nextCursor`;
- continuing with `nextCursor` returns the remaining row, no duplicate, `hasMore: false`, and `nextCursor: null`;
- `connectionId` restricts positions and totals; an unconfigured ID yields `isError` before the fake bank can be asked;
- one failed connection preserves the other connection’s output and supplies `unavailable`; all failed selected connections return `isError`; empty selected connections and zero configured connections succeed empty;
- malformed cursor and out-of-range/non-integer `limit` yield readable input errors.

Use builders and table cases for the empty, partial and total-failure permutations. Do not assert logger call counts. Assert that the response never embeds full position data in log fields only if the fake logger exposes structured entries without testing logging implementation details.

**Step 2: Run the tool test to verify RED**

Run:

```bash
nvm use && node --test tests/mcp/tools/investments.test.ts
```

Expected: the handler import is missing.

**Step 3: Implement the tool**

Register `getInvestments` with the project’s three-part description template in its module. Add this Zod boundary schema:

```ts
z.object({
  connectionId: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(100).default(100),
  cursor: z.string().min(1).optional(),
})
```

The handler must:

1. parse input with `safeParse` and return existing readable validation errors;
2. reject configuration problems using `configurationProblems`;
3. choose all configured connections or validate one supplied `connectionId` against `source.connections` before collection;
4. decode the cursor against the selected filter before collection;
5. collect positions, return `isError` only when at least one selected connection exists and all selected requests failed;
6. sort all positions with `compareInvestmentPositions`, compute all-position totals and `totalPositions`, select the first row strictly after the decoded tuple with that same comparator, take `limit + 1` rows, and derive `hasMore` and `nextCursor`;
7. format money only with `toDecimal`, omit quantity when it is null, and emit counts and outcomes rather than the position array in logs.

**Step 4: Run the tool test to verify GREEN**

Run:

```bash
nvm use && node --test tests/mcp/tools/investments.test.ts
```

Expected: pagination, filtering, validation, empty and partial failure behavior all pass.

**Step 5: Refactor only after GREEN**

Keep formatting in the tool like existing MCP handlers. Keep collection, sorting and totals in `core/`. Do not make `getAccounts` call or depend on this tool.

## Task 6: Register the assembled MCP tool

**Files:**
- Modify: `src/mcp/server.ts:6-50`
- Modify: `tests/mcp/server.test.ts:1-46`

**Step 1: Write the failing assembled-server test**

Extend the existing `InMemoryTransport` test setup with a healthy `Source` from `fakeSource({ investments: ... })`. Connect an MCP `Client`, invoke `getInvestments`, and assert the parsed tool result contains a position and whole-portfolio total. Add `getInvestments` to the expected `listTools()` array in its intended registrar order.

**Step 2: Run the server test to verify RED**

Run:

```bash
nvm use && node --test tests/mcp/server.test.ts
```

Expected: the handler exists but `getInvestments` is absent from the server's registered tool list.

**Step 3: Add server registration**

Import `registerGetInvestments` and add it to the single `REGISTRARS` list near the account and balance tools. Do not add a CLI subprocess test. The CLI composes the live Pluggy client and has no fake-bank injection seam. The assembled MCP server test still exercises public tool registration, schema parsing, handler composition and JSON formatting without credentials.

**Step 4: Run the server test to verify GREEN**

Run:

```bash
nvm use && node --test tests/mcp/server.test.ts
```

Expected: the client discovers and invokes `getInvestments` through the assembled MCP server.

## Task 7: Run the repository quality gates

**Files:** No production changes expected.

**Step 1: Run focused feature tests**

```bash
nvm use && node --test tests/core/investment.test.ts tests/pluggy/wire.test.ts tests/pluggy/mapper.test.ts tests/pluggy/client.test.ts tests/mcp/investment-cursor.test.ts tests/mcp/tools/investments.test.ts tests/mcp/server.test.ts
```

Expected: every changed behavior passes together.

**Step 2: Run the required project sequence**

```bash
nvm use && npm run typecheck
nvm use && npm run lint
nvm use && npm run deps
nvm use && npm test
nvm use && npm run build
```

Expected: typecheck, lint, dependency rules, tests and build pass in CI order.

**Step 3: Run mutation testing for changed Pluggy/core logic**

```bash
nvm use && npm run mutation
```

Read survivors in `src/core/investment.ts` and the investment mapper/client path. Add assertions for any surviving mutation that exposes an untested investment rule. Suppress only equivalent mutants with a Stryker reason.

**Step 4: Do not commit**

Leave the reviewed, verified working tree uncommitted unless the user explicitly requests a commit.

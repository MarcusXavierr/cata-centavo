# Phase 1 — accounts and balances: implementation plan

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task.

**Goal:** Ship `getAccounts`, `getBalance` and `getBalanceByAccount` as an MCP server over stdio, wired into a local Claude Code session.

**Architecture:** Pluggy is reached through `src/pluggy/` (wire schemas, client, mapper), which returns our `Account` domain type. The fan-out across configured connections and every totalling rule live in `src/core/`, pure and I/O-free. `src/mcp/` registers three tools and receives everything by injection; only `src/bin/` constructs infrastructure. No cache, no SQLite in `serve`.

**Tech Stack:** Node 24 (native TypeScript stripping), `@modelcontextprotocol/sdk` ^1.29.0, `zod` ^4.4.3, `pino`, `node --test`, Stryker.

**Design:** `docs/plans/2026-07-26-phase-1-accounts-and-balances-design.md`. Read it before Task 1. Where this plan and the design disagree, the design wins.

---

## Before you start

Every command block assumes you have run `nvm use` in that shell. Node 18 is this machine's default and it fails misleadingly: one test file dies with `ERR_UNKNOWN_FILE_EXTENSION`, and `npm test` reports `# tests 0` and exits 0 — a green run that executed nothing.

```bash
nvm use    # reads .nvmrc → v24.15.0
node -v    # must print v24.15.0
```

**The validation sequence, in this order, after every task:**

```bash
npm run typecheck && npm run lint && npm run deps && npm test
```

Order matters. Node strips types without checking them, so `tsc` is the only type checking that exists; `deps` is the architecture rule enforcement, and it will catch a forbidden import before a reviewer does.

**Compiler flags that will bite you.** All of these are on in `tsconfig.json`:

- `erasableSyntaxOnly` — no `enum`, no parameter properties (`constructor(private x)`). Both crash at runtime, so `tsc` rejects them. Use a `const` object plus a derived union; `src/cli/dispatch.ts` is the pattern.
- `noImplicitOverride` — a subclass field redeclaring a base field needs `override`. Task 2 hits this.
- `strictPropertyInitialization` (via `strict`) — a declared class field with no initializer and no constructor assignment is an error. Task 2 hits this too.
- `noUncheckedIndexedAccess` — `array[0]` is `T | undefined`. The house pattern is `assert.ok(first)` or `?? ""`; see `tests/pluggy/client.test.ts:102`.
- `exactOptionalPropertyTypes` — you cannot assign `undefined` into an optional field. Task 8 uses this deliberately, to make "omit the key" the only expressible option.

Source files import with `.ts` extensions (`from "./balance.ts"`); the build rewrites them. Nothing but JSON-RPC may reach stdout.

**On the size sensors:** `complexity`, `max-lines-per-function`, `max-params`, `max-depth`, `max-statements` and `max-lines` are all **warnings** in `eslint.config.js` and do not fail the build. They are sensors — read them, and prefer extracting a named function to ignoring them. The error-level `local/complexity-ceiling` rule does *not* measure your code: it only rejects an inline `/* eslint complexity: [...] */` comment that raises the threshold above 7. You cannot trip it by writing a big function, only by trying to silence the sensor.

**On commits:** this repository's `CLAUDE.md` says do not commit unless asked. The commit step at the end of each task is written out so it is ready, but **ask before running it** unless the person you are working with has already said to commit as you go.

---

## Task 0: Step 0 — probe the endpoints

**This task is research, not TDD.** It answers four questions the rest of the plan depends on. Do not skip it and do not guess the answers.

**Files:**
- Create: `scripts/probe-phase-1.ts` (throwaway; delete at the end of this task)
- Create: `docs/research/2026-07-26-phase-1-probe.md`
- Create: `tests/fixtures/accounts-bank.json`, `tests/fixtures/accounts-credit.json`

**Step 1: Write the probe**

A read-only script in the shape of the Phase 0.5 capture. It reads `PLUGGY_CLIENT_ID`, `PLUGGY_CLIENT_SECRET` and `PLUGGY_ITEM_IDS` from the environment, authenticates via `POST /auth`, and for each configured item:

- `GET /accounts?itemId={id}&pageSize=500&page=1` — record `total`, `totalPages`, `page`, and the full `results`
- `GET /investments?itemId={id}` — record the **status code** first, then the body if 200
- `GET /loans?itemId={id}` — same
- `GET /accounts/{accountId}` for one account id from the list above — record the status and whether the body carries `itemId`
- `GET /items/{id}` — to confirm `lastUpdatedAt` lives here and not on the account

Write every raw body to a scratch file. Do not summarize before saving; ADR §16.2 records the prior implementation deleting the evidence before a human could see it.

**Step 2: Run it**

```bash
nvm use
PLUGGY_CLIENT_ID=… PLUGGY_CLIENT_SECRET=… PLUGGY_ITEM_IDS=… node scripts/probe-phase-1.ts
```

**Step 3: Answer the five questions in `docs/research/2026-07-26-phase-1-probe.md`**

1. **Do `/investments` and `/loans` answer 200, 404 or 410?** If 200, record the shape of one position and one loan. The design specifies both branches; you are choosing between two written outcomes, not opening a new question.
2. **What is the sign of `balance` on a credit card?** Do not just look at it — *decide* it. For each of the three cards compute `creditLimit − availableCreditLimit` and compare against `balance`. If they match in magnitude and `balance` is positive, a card balance is positive debt. Record all three pairs.
3. **Does `GET /accounts/{id}` work, and does the body carry `itemId`?** Both halves matter. Task 13 checks the returned `itemId` against the configured set, and cannot if the field is absent.
4. **Do `balance`, `creditLimit` and `availableCreditLimit` carry sub-cent noise?** For every account assert `Math.abs(value * 100 - Math.round(value * 100)) < 1e-6`. The recon measured this on transaction `amount` only.
5. **What distinct values does `type` take?** Record every one seen. Task 5 turns an unrecognized value into a parse failure, and you need to know the recognized set to write it.

**Step 4: Capture anonymized fixtures**

Save one BANK account and one CREDIT account as `tests/fixtures/accounts-bank.json` and `tests/fixtures/accounts-credit.json`, **in the paginated envelope Pluggy returns** (`{total, totalPages, page, results}`). Replace every amount, name, `number`, `owner` and `taxNumber` with a synthetic value before saving. Keep the *shape* — key presence, null versus absent — exactly as it arrived; that is the whole point of a fixture.

Keep the credit fixture's `balance` consistent with its `creditLimit − availableCreditLimit`, because Task 5 asserts exactly that relationship.

The repository is public. Never commit a real statement.

**Step 5: Delete the probe script**

```bash
rm scripts/probe-phase-1.ts
```

It has done its job and this is a feature branch — no `probeV2`, no keeping it "just in case".

**Step 6: Commit**

```bash
git add docs/research/2026-07-26-phase-1-probe.md tests/fixtures/
git commit -m "docs: capture the Phase 1 endpoint probe"
```

---

## Task 1: The stdout lint rule

Do this first so it is enforcing while you write everything else.

**Files:**
- Modify: `eslint.config.js` — the `rules` block that already holds `"no-console": "error"`

**Step 1: Add the rule**

```js
"no-console": "error",
"no-restricted-properties": [
  "error",
  {
    object: "process",
    property: "stdout",
    message: "stdout is the JSON-RPC channel (ADR §4). Human-facing output goes to stderr.",
  },
],
```

**Step 2: Verify it passes on the current tree**

```bash
nvm use && npm run lint
```

Expected: clean. Nothing in `src/` writes stdout today — `say()` in `src/bin/cata-centavo.ts:53` already uses `process.stderr.write`.

**Step 3: Verify it actually catches something**

Temporarily add `process.stdout.write("x");` to `src/bin/cata-centavo.ts`, run `npm run lint`, confirm the error names the rule, then remove the line. A lint rule you never saw fail is a lint rule you cannot trust.

**Step 4: Commit**

```bash
git add eslint.config.js
git commit -m "chore: ban process.stdout in src"
```

---

## Task 2: The failure taxonomy

`core/` and `mcp/` both need to know *why* a call failed, and neither may import `src/pluggy/errors.ts` — `.dependency-cruiser.js` forbids it. So the discriminant moves to `core/contracts.ts` and `pluggy/errors.ts` maps onto it.

**Files:**
- Modify: `src/core/contracts.ts`
- Modify: `src/pluggy/errors.ts`
- Test: `tests/pluggy/client.test.ts` (extend — it already has a table at line 228 mapping status codes onto error classes; add a `kind` column to that table rather than creating a second file for the same seam)

**Step 1: Extend the existing table**

Find the "maps the status codes onto distinguishable errors" test and give each row a `kind`:

```ts
const cases = [
  { status: 401, error: AuthError,          kind: "auth" },
  { status: 403, error: AuthError,          kind: "auth" },
  { status: 404, error: NotFoundError,      kind: "unknown-connection" },
  { status: 429, error: RateLimitError,     kind: "rate-limited" },
  { status: 500, error: HttpError,          kind: "unavailable" },
] as const;
```

Assert `kind` alongside the existing class assertion, in the same body.

**Step 2: Run it and watch it fail**

```bash
nvm use && node --test tests/pluggy/client.test.ts
```

Expected: FAIL — `kind` is `undefined`.

**Step 3: Implement**

In `src/core/contracts.ts`:

```ts
/**
 * Why a call to the bank failed, in a form `core/` and `mcp/` can switch on.
 *
 * It lives here rather than beside the Pluggy error classes because the
 * dependency rules forbid both consumers from importing them (ADR §6), and
 * §16.4's "decide per failure" is undecidable without something to switch on.
 */
export type FailureKind =
  | "auth"
  | "unknown-connection"
  | "rate-limited"
  | "unavailable"
  | "no-accounts"
  | "bad-response";

export type BankFailure = {
  readonly kind: FailureKind;
  readonly message: string;
};
```

In `src/pluggy/errors.ts` — and write it this way, because the obvious shape does not compile. A bare `readonly kind: FailureKind` on the base trips `strictPropertyInitialization`, and redeclaring it in a subclass trips `noImplicitOverride`:

```ts
export class PluggyError extends Error {
  readonly status: number | undefined;
  readonly kind: FailureKind;

  constructor(message: string, kind: FailureKind, status?: number) {
    super(message);
    this.name = new.target.name;
    this.kind = kind;
    this.status = status;
  }
}

export class AuthError extends PluggyError {
  constructor(message: string, status?: number) {
    super(message, "auth", status);
  }
}
```

The same shape for `NotFoundError` (`"unknown-connection"`), `RateLimitError` (`"rate-limited"`), `HttpError` (`"unavailable"`) and `ResponseShapeError` (`"bad-response"`). No parameter properties — `erasableSyntaxOnly` rejects them.

`"no-accounts"` has no Pluggy status; `core/` raises that one itself in Task 9.

Add a `toFailure(error: unknown): BankFailure` export — a `PluggyError` maps to `{kind, message}`, anything else to `{kind: "unavailable", message: String(error)}`. This is the only place `unknown` becomes structured. `core/` receives it as a parameter rather than importing it; see Task 9.

**Step 4: Check the existing call sites**

`classify` constructs each class with `(message, status)`. Those calls now compile unchanged because the subclass constructors kept that signature — but `tests/fakes/fake-bank.ts:29` and `:41` also construct `NotFoundError` and `AuthError` directly. Run the full suite, not just one file.

**Step 5: Run and watch it pass**

```bash
npm run typecheck && npm run lint && npm run deps && npm test
```

**Step 6: Commit**

```bash
git add src/core/contracts.ts src/pluggy/errors.ts tests/pluggy/client.test.ts
git commit -m "feat: give bank failures a kind core can switch on"
```

---

## Task 3: `toCents`

**Files:**
- Modify: `src/pluggy/mapper.ts`
- Test: `tests/pluggy/mapper.test.ts` (create — `mapper.ts` has no test file today; `toConnection` is currently exercised through `tests/pluggy/client.test.ts`, which is a different seam)

**Step 1: Write the failing test**

One table covering the three properties the design specifies. Do not write eight near-identical `it()` blocks.

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { toCents } from "../../src/pluggy/mapper.ts";

describe("toCents", () => {
  const cases = [
    { value: 0, cents: 0, why: "zero survives" },
    { value: 1500, cents: 150000, why: "a whole real" },
    { value: 15.5, cents: 1550, why: "one decimal place" },
    { value: 1234.56, cents: 123456, why: "two decimal places" },
    { value: -800.25, cents: -80025, why: "a negative balance" },
    { value: 0.005, cents: 1, why: "half rounds away from zero" },
    { value: -0.005, cents: -1, why: "and symmetrically below zero" },
    { value: -0.001, cents: 0, why: "rounds to positive zero, never -0" },
  ];

  for (const { value, cents, why } of cases) {
    it(why, () => {
      assert.equal(toCents(value), cents);
    });
  }

  it("is symmetric across zero", () => {
    assert.equal(toCents(-1.005), -toCents(1.005));
  });
});
```

The last table row is a complete `-0` guard on its own. This file imports `node:assert/strict`, where `equal` *is* `strictEqual`, which compares with `Object.is` — so `assert.equal(-0, 0)` throws. No separate `Object.is` test is needed.

**Step 2: Run it and watch it fail**

```bash
nvm use && node --test tests/pluggy/mapper.test.ts
```

**Step 3: Implement**

```ts
/**
 * Money as integer cents, at the one point a Pluggy number becomes ours.
 *
 * `Math.round` alone satisfies none of the three properties this needs:
 * it rounds half *up* rather than away from zero, which is asymmetric across
 * zero, and `Math.round(-0.4)` is `-0`. A credit card balance may well arrive
 * negative, so the negative path is live rather than theoretical.
 */
export function toCents(value: number): number {
  const cents = Math.sign(value) * Math.round(Math.abs(value) * 100);
  return cents === 0 ? 0 : cents;
}
```

**Step 4: Run it and watch it pass**

```bash
node --test tests/pluggy/mapper.test.ts
npm run typecheck && npm run lint && npm run deps && npm test
```

**Step 5: Commit**

```bash
git add src/pluggy/mapper.ts tests/pluggy/mapper.test.ts
git commit -m "feat: convert money to integer cents at the mapper"
```

---

## Task 4: The `Account` domain type

**Files:**
- Create: `src/core/account.ts`

No test — this file is types only, and a test asserting a type exists is a test asserting the compiler works. `npm run deps` will warn `no-orphans` until Task 5 imports it; that warning is expected and clears itself.

**Step 1: Write it**

```ts
/**
 * An account as we speak of it, which is not as Pluggy speaks of it (ADR §14.1).
 * `type` is a superset of Pluggy's `BANK | CREDIT` because investments and loans
 * are representable under neither; `pluggy/mapper.ts` owns the widening.
 */
export const ACCOUNT_TYPES = {
  bank: "BANK",
  credit: "CREDIT",
  investment: "INVESTMENT",
  loan: "LOAN",
} as const;

export type AccountType = (typeof ACCOUNT_TYPES)[keyof typeof ACCOUNT_TYPES];

export type Account = {
  readonly id: string;
  readonly connectionId: string;
  readonly institution: string;
  readonly name: string;
  readonly type: AccountType;
  readonly subtype: string | null;
  readonly balanceCents: number;
  readonly currency: string;
  /** Of the connection, not the account — Pluggy carries it on the item. */
  readonly lastUpdatedAt: Date | null;
  /** Populated only on `type: "CREDIT"`. */
  readonly credit: CreditDetails | null;
};

export type CreditDetails = {
  readonly limitCents: number | null;
  readonly availableLimitCents: number | null;
  readonly balanceCloseDate: Date | null;
  readonly balanceDueDate: Date | null;
  readonly brand: string | null;
};
```

A `const` object plus a derived union, not an `enum` — `erasableSyntaxOnly` rejects `enum`. `credit` is `CreditDetails | null` rather than five optional fields because `exactOptionalPropertyTypes` makes optional readonly members awkward to build conditionally.

**Step 2: Typecheck**

```bash
nvm use && npm run typecheck
```

**Step 3: Commit**

```bash
git add src/core/account.ts
git commit -m "feat: add the Account domain type"
```

---

## Task 5: The wire schema and `toAccount`

**Files:**
- Modify: `src/pluggy/wire.ts`
- Modify: `src/pluggy/mapper.ts`
- Test: `tests/pluggy/mapper.test.ts` (extend — do not create a second file)

**Step 1: Write the failing tests**

A typed fixture helper, which doubles as a shape assertion — the point of capturing a fixture at all:

```ts
import { ACCOUNT_PAGE, type WireAccount } from "../../src/pluggy/wire.ts";

function accountFixture(name: string): WireAccount {
  const raw: unknown = JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), "utf8"));
  const [first] = ACCOUNT_PAGE.parse(raw).results;
  assert.ok(first, `${name} fixture has no accounts`);
  return first;
}
```

The `assert.ok` is not defensive padding — `noUncheckedIndexedAccess` makes `results[0]` be `WireAccount | undefined`, and this is how the house style narrows it.

Then, using a shared `const connection = connection("conn-1")` from `tests/fakes/fake-bank.ts`:

```ts
it("maps a credit card onto our shape", () => { … });        // type CREDIT, credit populated,
                                                             // balanceCloseDate null (recon: null on all three cards)
it("takes freshness from the connection, not the account", () => { … });
it("rejects an account type we do not recognise", () => {
  assert.throws(() => toAccount({ ...bankWire, type: "SOMETHING_NEW" }, conn), ResponseShapeError);
});
```

And the guard the design calls for:

```ts
it("agrees with the credit limit about how much is owed", () => {
  const account = toAccount(accountFixture("accounts-credit"), conn);
  const { limitCents, availableLimitCents } = account.credit ?? {};
  assert.ok(limitCents !== null && availableLimitCents !== null);
  assert.equal(account.balanceCents, limitCents - availableLimitCents);
});
```

If Task 0 found the sign inverted, this assertion is what encodes the correction — write it against what the probe measured, not against what you expect.

**Step 2: Run and watch them fail**

```bash
nvm use && node --test tests/pluggy/mapper.test.ts
```

**Step 3: Implement the schema**

In `src/pluggy/wire.ts`, following the file's conventions — `.nullish()` on nested optional members, unknown keys dropped, dates as `string` because we parse the raw body rather than going through the SDK's date reviver:

```ts
export const ACCOUNT = z.object({
  id: z.string().min(1),
  itemId: z.string().min(1),
  type: z.string(),
  subtype: z.string().nullish(),
  name: z.string(),
  marketingName: z.string().nullish(),
  balance: z.number(),
  currencyCode: z.string(),
  creditData: z
    .object({
      brand: z.string().nullish(),
      balanceCloseDate: z.string().nullish(),
      balanceDueDate: z.string().nullish(),
      availableCreditLimit: z.number().nullish(),
      creditLimit: z.number().nullish(),
    })
    .nullish(),
});

/** Pluggy's offset envelope. `/accounts` still uses it; only `/transactions` moved to cursors. */
export const ACCOUNT_PAGE = z.object({
  total: z.number(),
  totalPages: z.number(),
  page: z.number(),
  results: z.array(ACCOUNT),
});

export type WireAccount = z.infer<typeof ACCOUNT>;
```

Adjust every field against what Task 0 captured. If the probe found a field this omits and we read it, add it; if it found one of these absent, make it `.nullish()`.

**Step 4: Implement the mapper**

`toAccount(account: WireAccount, connection: Connection): Account`. Prefer `marketingName ?? name`, run every monetary field through `toCents`, take `lastUpdatedAt` from the connection, and extract `toCreditDetails(creditData)` as its own function.

**An unrecognized `type` throws `ResponseShapeError`.** It means Pluggy changed, which is exactly what that class is for. The alternative — a default bucket or a silent skip — either misfiles money or drops an account out of every figure and out of `accountsCounted`, with no error anywhere. That is PRD failure #1. This is deliberately the opposite choice from `Connection.status`, which `core/contracts.ts:41-48` argues should stay open: losing a connection report to an unknown status is the worse failure there, and silently misfiling money is the worse failure here.

**Step 5: Run and watch them pass**

```bash
node --test tests/pluggy/mapper.test.ts
npm run typecheck && npm run lint && npm run deps && npm test
```

**Step 6: Commit**

```bash
git add src/pluggy/wire.ts src/pluggy/mapper.ts tests/pluggy/mapper.test.ts
git commit -m "feat: map a Pluggy account onto our domain type"
```

---

## Task 6: Grow `Bank` — contract, client and fake together

**These three files must change in one commit.** `tests/fakes/fake-bank.ts:12` declares `FakeBank = Bank & { calls }` and returns an object literal, and `createPluggyClient` returns `Bank`. The moment `Bank` grows two members, both stop compiling — so growing the contract without the two implementers leaves the tree red, and there is no ordering of separate tasks that avoids it.

**Files:**
- Modify: `src/core/contracts.ts` — add both operations to `Bank`
- Modify: `src/pluggy/client.ts`
- Modify: `tests/fakes/fake-bank.ts`
- Test: `tests/pluggy/client.test.ts` (extend — the client seam is already tested there)

**Step 1: Write the failing tests**

Against `tests/fakes/fake-fetch.ts`. Note its recorded array is `requests`, not `calls`, and `requests[0]` is always the `POST /auth` that precedes every read — see `tests/pluggy/client.test.ts:94-96`. Under `noUncheckedIndexedAccess` an index is `| undefined`, so narrow the way line 102 already does.

```ts
it("follows every page to the reported totalPages", async () => {
  // page 1 of 2, then page 2. Assert BOTH pages' accounts come back,
  // and that the request carried pageSize=500.
});

it("asks for the item as well as the accounts", async () => {
  // assert one /items/{id} request and one /accounts?itemId= request
});

it("puts the requested account id in the path", async () => {
  await client.getAccount("acc-1");
  const read = fetch.requests.find((request) => request.url.includes("/accounts/"));
  assert.match(read?.url ?? "", /\/accounts\/acc-1(\?|$)/);
});
```

The pagination test is not optional. ADR §14.2 records the prior Go implementation sending no pagination parameters and silently receiving Pluggy's default of 20 — six accounts fit in one page today and twenty-one will not, and the failure is silent and financial.

Do not try to assert *concurrency* from `requests` alone; ordering in that array does not prove it. If you want it, use the gate pattern at `tests/pluggy/client.test.ts:166-192`. Otherwise assert both requests were issued and leave it there.

**Step 2: Run and watch them fail**

```bash
nvm use && node --test tests/pluggy/client.test.ts
```

**Step 3: Grow the contract**

In `src/core/contracts.ts`:

```ts
  /** Every account on one connection, with the connection's freshness stamped on each. */
  getAccounts(connectionId: string): Promise<readonly Account[]>;
  /** Rejects with a `NotFoundError` when Pluggy does not know the id. */
  getAccount(accountId: string): Promise<Account>;
```

**Step 4: Implement the client**

`getAccounts` issues `GET /items/{id}` and the first page of `GET /accounts?itemId={id}&pageSize=500&page=1` in parallel via `Promise.all`, then fetches pages 2..`totalPages` if there are any, and loops to the *reported* `totalPages` rather than stopping on a short page.

The item fetch is not overhead: it is the only source of `lastUpdatedAt`, and it also supplies `status`, which is how a connection stuck in `UPDATING` stops looking like a healthy empty one.

`getAccount` fetches `GET /accounts/{id}`, then `GET /items/{itemId}` from the returned body to stamp freshness.

**Step 5: Extend the fake**

`FakeBankOptions` gains `accounts?: Readonly<Record<string, readonly Account[]>>` keyed by connection id. The existing `unreachable` map covers both new methods unchanged — it already throws the real `NotFoundError`, so callers meet the same classification they will face in production. An id present in `accounts` with an empty array is the zero-accounts case Task 9 needs; do not special-case it here, `core/` decides what empty means.

**Record the method, not just the id.** `calls` is a flat `string[]` shared by all three operations, and Task 13 needs to prove `getAccount` received an id rather than something else did. Push `getAccounts:conn-1` and `getAccount:acc-5`, and keep `getConnection` pushing the bare id so `tests/cli/init.test.ts` keeps passing unchanged.

Add two builders beside the existing `connection(id, overrides)`:

- `account(id, overrides)` — so no test spells out ten fields to vary one.
- `threeConnections()` — three connections, six accounts, one checking and one card each. Tasks 9, 13 and 14 all need this exact fixture; writing it once here is what stops it being copy-pasted into three files.

**Step 6: Run and watch them pass**

```bash
npm run typecheck && npm run lint && npm run deps && npm test
```

**Step 7: Commit**

```bash
git add src/core/contracts.ts src/pluggy/client.ts tests/fakes/fake-bank.ts tests/pluggy/client.test.ts
git commit -m "feat: fetch accounts and one account from Pluggy"
```

---

## Task 7: `core/balance.ts` — the totalling rules

This is the file where a mistake costs the user a wrong number. It is pure, it needs no I/O, and it carries the tests that matter most.

**Files:**
- Create: `src/core/balance.ts`
- Test: `tests/core/balance.test.ts` (create — genuinely a new unit)

**Step 1: Write the failing tests**

One table, using the `account()` builder from Task 6. Every row carries a **complete** `Summary`, including `currency`, so `assert.deepEqual(result.summary, expected)` works uniformly:

```ts
const cases = [
  {
    why: "a card bill never lands in cash",
    accounts: [account("a", { type: "BANK", balanceCents: 150000 }),
               account("b", { type: "BANK", balanceCents: 50000 }),
               account("c", { type: "CREDIT", balanceCents: 80000 })],
    expected: { cashCents: 200000, owedCents: 80000, currency: "BRL", accountsCounted: 3 },
  },
  {
    why: "an exactly-zero balance is counted, not dropped",
    accounts: [account("a", { type: "BANK", balanceCents: 0 }),
               account("b", { type: "BANK", balanceCents: 30000 })],
    expected: { cashCents: 30000, owedCents: 0, currency: "BRL", accountsCounted: 2 },
  },
  {
    why: "a loan is kept apart from a card bill",
    accounts: [account("a", { type: "CREDIT", balanceCents: 80000 }),
               account("b", { type: "LOAN", balanceCents: 2200000 })],
    expected: { cashCents: 0, owedCents: 80000, loanCents: 2200000, currency: "BRL", accountsCounted: 2 },
  },
];
```

Plus three that assert a different return shape and so stay outside the table:

```ts
it("omits invested when no investment account exists", () => {
  const result = summarize([account("a", { type: "BANK", balanceCents: 30000 })]);
  assert.ok(result.ok);
  assert.ok(!("investedCents" in result.summary));   // absent, not zero
});

it("refuses to total across two currencies", () => {
  const result = summarize([
    account("a", { type: "BANK", balanceCents: 150000, currency: "BRL" }),
    account("b", { type: "BANK", balanceCents: 20000, currency: "USD" }),
  ]);
  assert.equal(result.ok, false);
  assert.deepEqual(result.currencies, ["BRL", "USD"]);
});

it("refuses an empty account list rather than inventing a currency", () => {
  assert.equal(summarize([]).ok, false);
});
```

The `in` check rather than `=== undefined` is deliberate: the criterion is that the key is *absent*, and `{investedCents: undefined}` satisfies the weaker check while serializing into a claim we cannot support.

The empty case is reachable — Task 8's "every connection unavailable" path produces it — and `Summary.currency` has nothing to read when there are no accounts, so it must not return `ok: true`.

**Step 2: Run and watch them fail**

```bash
nvm use && node --test tests/core/balance.test.ts
```

**Step 3: Implement**

```ts
export type Summary = {
  readonly cashCents: number;
  readonly owedCents: number;
  readonly investedCents?: number;
  readonly loanCents?: number;
  readonly currency: string;
  readonly accountsCounted: number;
};

export type SummaryResult =
  | { readonly ok: true; readonly summary: Summary }
  | { readonly ok: false; readonly currencies: readonly string[] };

export function summarize(accounts: readonly Account[]): SummaryResult;
```

`BANK` sums into cash, `CREDIT` into owed, `LOAN` into loans, `INVESTMENT` into invested. The `investedCents` and `loanCents` keys are **built conditionally and omitted entirely** when no account of that type exists — under `exactOptionalPropertyTypes` you cannot assign `undefined` into them, which is the type system enforcing the rule for you.

More than one distinct currency, or none at all, returns `{ok: false, currencies}` with the currencies sorted. It never picks one and never converts: nothing on an account balance corresponds to the transaction-level `amountInAccountCurrency` rescue, so refusing is the only correct move.

**Step 4: Run and watch them pass**

```bash
node --test tests/core/balance.test.ts
npm run typecheck && npm run lint && npm run deps && npm test
```

**Step 5: Commit**

```bash
git add src/core/balance.ts tests/core/balance.test.ts
git commit -m "feat: total cash, debt, loans and investments separately"
```

---

## Task 8: `core/accounts.ts` — the fan-out and partial failure

**Files:**
- Create: `src/core/accounts.ts`
- Test: `tests/core/accounts.test.ts` (create — genuinely a new unit)

**Step 1: Write the failing tests**

All four cases vary only in how the fake is configured and what the counts come out as, so this is one table, not four `it()` blocks. Arrange with `threeConnections()` from Task 6.

```ts
const cases = [
  { why: "returns every account when every connection answers",
    broken: {}, expectAccounts: 6, expectUnavailable: [] },
  { why: "returns what it has and names what failed",
    broken: { "conn-2": new AuthError("refused", 401) },
    expectAccounts: 4, expectUnavailable: [{ connectionId: "conn-2", kind: "auth" }] },
  { why: "names every connection when none answer",
    broken: { "conn-1": …, "conn-2": …, "conn-3": … },
    expectAccounts: 0, expectUnavailable: [ …three… ] },
  { why: "treats a connection with no accounts as unavailable",
    empty: ["conn-2"],
    expectAccounts: 4, expectUnavailable: [{ connectionId: "conn-2", kind: "no-accounts" }] },
];
```

The fourth closes the silent hole: a revoked consent does not throw, it answers `200` with an empty list, and without this `getBalance` would happily total over a subset.

**Step 2: Run and watch them fail**

```bash
nvm use && node --test tests/core/accounts.test.ts
```

**Step 3: Implement**

```ts
export type UnavailableConnection = BankFailure & { readonly connectionId: string };

export type CollectedAccounts = {
  readonly accounts: readonly Account[];
  readonly unavailable: readonly UnavailableConnection[];
};

export async function collectAccounts(
  bank: Bank,
  connectionIds: readonly string[],
  toFailure: (error: unknown) => BankFailure,
): Promise<CollectedAccounts>;
```

`toFailure` arrives as a parameter rather than an import, because `core/` may not import `src/pluggy/errors.ts` and the contract belongs to the consumer. `bin/` injects the real one; the test injects a trivial one.

Use `Promise.allSettled` — it produces the partial-failure result directly, and concurrency is what the transport's single-flight guard was built for: its docblock at `src/pluggy/transport.ts:141` names this exact caller. Sequential would multiply latency by the number of connections inside an agent loop for no benefit.

An empty account list from a *fulfilled* promise becomes `{kind: "no-accounts", message: …}`. Say plainly in the message that the connection answered but returned nothing, and that a revoked consent is the usual cause.

**Step 4: Run and watch them pass**

```bash
node --test tests/core/accounts.test.ts
npm run typecheck && npm run lint && npm run deps && npm test
```

**Step 5: Commit**

```bash
git add src/core/accounts.ts tests/core/accounts.test.ts
git commit -m "feat: fan out over connections with per-connection failure"
```

---

## Task 9: `mcp/format.ts`

**Files:**
- Create: `src/mcp/format.ts`
- Modify: `stryker.config.json`
- Test: `tests/mcp/format.test.ts` (create)

**Step 1: Write the failing tests**

Two tables. The first for `toDecimal`:

```ts
const money = [
  { cents: 0, text: "0.00", why: "zero is a real number and must survive" },
  { cents: 5, text: "0.05" },
  { cents: 150000, text: "1500.00" },
  { cents: 123456, text: "1234.56" },
  { cents: -80025, text: "-800.25" },
];
```

The second for `prune`, and this one is the point of the file:

```ts
const pruning = [
  { input: { a: null }, output: {}, why: "null is dropped" },
  { input: { a: undefined }, output: {}, why: "undefined is dropped" },
  { input: { a: 0 }, output: { a: 0 }, why: "zero survives — a zero balance is not absence" },
  { input: { a: "" }, output: { a: "" }, why: "empty string survives" },
  { input: { a: false }, output: { a: false }, why: "false survives" },
  { input: { a: { b: null, c: 1 } }, output: { a: { c: 1 } }, why: "nested" },
];
```

A balance of exactly `0` disappearing is a financial bug, and `if (!value) delete` is the one-character way to ship it.

**Step 2: Run and watch them fail**

```bash
nvm use && node --test tests/mcp/format.test.ts
```

**Step 3: Implement**

`toDecimal(cents: number): string` — integer arithmetic only. No `/100` into a float and no `toFixed` on a divided value: split the sign, take `Math.trunc(abs / 100)` and `abs % 100`, pad the remainder to two digits.

`prune(value: unknown): unknown` — drops `null` and `undefined` only, recursively, never falsy.

**Step 4: Add `format.ts` to Stryker's scope**

In `stryker.config.json`:

```json
"mutate": ["src/core/**/*.ts", "src/pluggy/**/*.ts", "src/mcp/format.ts"],
```

The current scope excludes `src/mcp/` entirely, and this is the one function implementing both "strip only `null`/`undefined`" and the money conversion — precisely where a green-but-assertionless test survives.

**Step 5: Run and watch them pass**

```bash
node --test tests/mcp/format.test.ts
npm run typecheck && npm run lint && npm run deps && npm test
```

**Step 6: Commit**

```bash
git add src/mcp/format.ts tests/mcp/format.test.ts stryker.config.json
git commit -m "feat: format money as a decimal string and prune only absence"
```

---

## Task 10: `mcp/source.ts` and the handler shape

This task decides the shape every tool file takes, so it comes before any of them.

**Files:**
- Create: `src/mcp/source.ts`
- Create: `tests/fakes/fake-source.ts`

**Step 1: Write `Source` in its own module**

```ts
export type Source =
  | {
      readonly ok: true;
      readonly connections: readonly string[];
      readonly bank: Bank;
      readonly toFailure: (error: unknown) => BankFailure;
    }
  | { readonly ok: false; readonly problems: readonly string[] };
```

**It must not live in `server.ts`.** `server.ts` imports the tool registrars, and the handlers import `Source` back — `.dependency-cruiser.js` runs with `tsPreCompilationDeps: true`, so a type-only import is still an edge and `no-cycles` fails on `server.ts → tools/accounts.ts → server.ts`. Its own module breaks the cycle and is importable from `server.ts`, `tools/*.ts` and `bin/` alike.

**Step 2: Decide the handler shape, and write it down**

Each tool module exports two things:

```ts
export async function handleGetAccounts(deps: ToolDeps, input: …): Promise<CallToolResult>;
export function registerGetAccounts(server: McpServer, deps: ToolDeps): void;
```

The handler is a plain async function and the registrar is a thin wrapper that calls it. This is what makes Tasks 11–14 testable: `McpServer.registerTool` returns a handle with no public invoke path, so testing through the server would mean standing up `InMemoryTransport.createLinkedPair()` and a `Client` for every assertion. The tests call the pure handlers directly; one test in Task 12 proves registration happened.

**Step 3: Write the shared test harness**

`tests/fakes/fake-source.ts` exports `fakeSource({ accounts, unreachable, connections })` returning a ready `Source` over `fakeBank`, defaulting to `threeConnections()`. Tasks 12, 13 and 14 all build the same six-line arrange otherwise — the house style already solves this, at `tests/pluggy/client.test.ts:49` (`harness()`) and in `tests/cli/init.test.ts` (`deps()`).

**Step 4: Typecheck**

```bash
nvm use && npm run typecheck && npm run lint && npm run deps
```

`no-orphans` will warn until Task 11 imports it. Expected.

**Step 5: Commit**

```bash
git add src/mcp/source.ts tests/fakes/fake-source.ts
git commit -m "feat: add the MCP source union and its test harness"
```

---

## Task 11: `getAccounts` and `getBalanceByAccount`

**Files:**
- Create: `src/mcp/tools/accounts.ts`
- Test: `tests/mcp/tools/accounts.test.ts` (create)

**Step 1: Write the failing tests**

The one that matters most, standalone — it is the PRD rule #3 regression and deserves its own name:

```ts
it("passes the requested account id through to the bank", async () => {
  const source = fakeSource();
  await handleGetBalanceByAccount({ source, log }, { accountId: "acc-5" });
  assert.ok(source.bank.calls.includes("getAccount:acc-5"));
});
```

**This test belongs here, not at the transport.** A `fake-fetch` assertion on the URL proves the *client* builds the right path; the regression PRD rule #3 describes happened above that, between Zod and the client, where a handler passes a constant or the wrong field and the fetch-level test still passes. Task 6 keeps the transport-level test; they cover different seams.

Then a table for the two refusals, which share an assertion body (`isError`, message matches, no balance in the payload):

```ts
const refusals = [
  { why: "an account belonging to an unconfigured connection",
    // bank answers 200 with an account whose connectionId is not in `connections`
    expect: /unknown account/ },
  { why: "an account Pluggy does not recognise",
    expect: /unknown account/ },
];
```

The first is the subtle one. `GET /accounts/{id}` is authorized by the API key, which covers the whole Pluggy application rather than the subset in `PLUGGY_ITEM_IDS` — so an id belonging to an item the user has but has not configured returns **200**, not 404. `src/pluggy/errors.ts:62` already says the neighbouring half out loud. The tool checks the returned `connectionId` against the configured set and produces the refusal itself.

Then `getAccounts`:

```ts
it("lists every account with the unavailable connections named", async () => { … });
it("reports the config problems when the source is broken", async () => { … });
```

**Step 2: Run and watch them fail**

```bash
nvm use && node --test tests/mcp/tools/accounts.test.ts
```

**Step 3: Implement**

Validate `{ accountId: z.string().min(1) }` with Zod at the boundary. Every description follows ADR §14.0's three-part template.

`getAccounts`' description carries one extra sentence and it is a deliverable, not a detail: the tool hands the model every account's balance, so a model that gets a refused `getBalance` can sum `BANK` and `CREDIT` itself and produce exactly the number this design exists to prevent. The `Returns:` block says in words that these are per-account figures in different units — a `CREDIT` balance is an unpaid bill, not money held — and that consolidating them is what `getBalance` is for.

`lastUpdatedAt` serializes as ISO-8601 UTC. The recon warns that comparing these as calendar days needs a timezone and that UTC is the wrong one for a Brazilian midnight, so emit the instant and leave day arithmetic to whoever has a reason to pick a zone.

Every handler checks `source.ok` first and returns the config problems as readable `isError` content when it is false.

Wrap each call in `log.child({ tool, callId })`, `info` on entry, `info` on exit with `durationMs` and `outcome`, `warn` per unavailable connection. Balances and account names go at `debug`; `info` and `warn` carry counts (`{accounts: 6, unavailable: 1}`).

**Step 4: Run and watch them pass**

```bash
node --test tests/mcp/tools/accounts.test.ts
npm run typecheck && npm run lint && npm run deps && npm test
```

**Step 5: Commit**

```bash
git add src/mcp/tools/accounts.ts tests/mcp/tools/accounts.test.ts
git commit -m "feat: add getAccounts and getBalanceByAccount"
```

---

## Task 12: `getBalance`

**Files:**
- Create: `src/mcp/tools/balance.ts`
- Test: `tests/mcp/tools/balance.test.ts` (create)

**Step 1: Write the failing tests**

Three refusals share an assertion body — `isError`, the message matches, and `!("cash" in payload)` — so they are a table:

```ts
const refusals = [
  { why: "a connection failed",            arrange: …, expect: /conn-2/ },
  { why: "a connection returned no accounts", arrange: …, expect: /no-accounts|returned nothing/ },
  { why: "two currencies are present",     arrange: …, expect: /BRL.*USD/ },
];
```

Three more assert different things and stay standalone:

```ts
it("reports cash and debt as separate figures", …)   // cash "2000.00", owed "800.00",
                                                     // and NO field combining them
it("counts an account holding exactly zero", …)      // cash "300.00", accountsCounted 2
it("omits invested when no investment account exists", …)   // no `invested` key at all
```

Assert the *absence of a key*, not the absence of a claim. "The result does not state that the invested total is zero" is not something a test can express; `assert.ok(!("invested" in payload))` is.

**Step 2: Run and watch them fail**

```bash
nvm use && node --test tests/mcp/tools/balance.test.ts
```

**Step 3: Implement**

`getBalance` fails whole. It is an aggregate, and PRD rule #2 forbids reporting partial coverage as a total. No cash figure appears anywhere in a failed result — a number next to a caveat is a number that gets read without the caveat.

The payload:

```
{ cash, owed, invested?, loans?, currency, accountsCounted, asOf: [{connectionId, lastUpdatedAt}] }
```

Four labelled figures, no combined total. `invested` and `loans` omitted rather than zeroed when the accounts do not exist — an absent key is a claim we are not making, `"0.00"` is a claim we cannot support.

Staleness does **not** gate. A three-day-stale connection is still totalled, with its date in `asOf`. There is no threshold we could defend, because the connector gives us no way to tell "stale" from "stale and wrong".

**Step 4: Run and watch them pass**

```bash
node --test tests/mcp/tools/balance.test.ts
npm run typecheck && npm run lint && npm run deps && npm test
```

**Step 5: Commit**

```bash
git add src/mcp/tools/balance.ts tests/mcp/tools/balance.test.ts
git commit -m "feat: add getBalance"
```

---

## Task 13: `mcp/server.ts` — registration

**Files:**
- Create: `src/mcp/server.ts`
- Test: `tests/mcp/server.test.ts` (create)

**Step 1: Write the failing test**

```ts
it("lists all three tools even when the configuration is broken", async () => {
  const server = createServer({
    source: { ok: false, problems: ["PLUGGY_CLIENT_SECRET is missing or empty. …"] },
    version: "0.0.0",
    log: fakeLogger(),
  });
  // connect an InMemoryTransport pair, list tools, assert the three names
});
```

This is the one place worth standing up a real client, because "the tools are actually registered" is the only thing a direct handler call cannot prove.

**Step 2: Run and watch it fail**

**Step 3: Implement**

```ts
export function createServer(options: {
  readonly source: Source;
  readonly version: string;
  readonly log: Logger;
}): McpServer;
```

It calls `registerGetAccounts`, `registerGetBalanceByAccount` and `registerGetBalance` from the two tool modules, passing `{source, log}` through. Capabilities: `tools` only, no prompts, no resources.

Refusing to boot on a broken config produces a client that says "server failed" without saying which variable is missing. PRD rule #4 is that what the model can recover from must reach it as readable content — which is why `Source` is a union and the server registers regardless.

**Step 4: Verify the dependency rules**

```bash
npm run deps
```

Expected: clean. `no-cycles` is the one to watch — if it fires on `server.ts ↔ tools/`, something imported `Source` from `server.ts` instead of `source.ts`. `only-bin-builds-infrastructure` fires if `src/mcp/` reached into `src/pluggy/` or `src/storage/`; the fix is a parameter, not a rule exemption.

**Step 5: Commit**

```bash
git add src/mcp/server.ts tests/mcp/server.test.ts
git commit -m "feat: register the three tools on the MCP server"
```

---

## Task 14: The `serve` branch

**Files:**
- Modify: `src/bin/cata-centavo.ts` — the `run` function at lines 79-101

`COMMANDS.serve` already exists in `src/cli/dispatch.ts:14`, and `resolveInvocation` already dispatches no-argument invocations to it (`dispatch.ts:69-71`). Nothing about argument parsing needs to change.

**Step 1: Implement**

Add a `serve` branch **before** the stub, and leave the stub in place — `doctor` still needs it, and without it `run()` falls off the end with no return.

```ts
if (command === COMMANDS.serve) {
  const paths = resolvePaths(process.env, { platform: process.platform, home: homedir() });
  const log = createLogger({ env: process.env, logFile: paths.logFile });
  const result = loadConfig(process.env);

  const source: Source = result.ok
    ? {
        ok: true,
        connections: result.config.itemIds,
        bank: createPluggyClient({
          credentials: result.config.credentials,
          clock: systemClock, fetch: globalThis.fetch, sleep, log,
        }),
        toFailure,
      }
    : { ok: false, problems: result.problems };

  await createServer({ source, version: readVersion(), log })
    .connect(new StdioServerTransport());
  return 0;
}
```

`serve` opens **no** SQLite file. With no cache there is nothing to persist — do not call `prepareStorage`.

Do not `process.exit` on a bad config. The whole point of the `Source` union is that a missing variable is reported through the tool rather than by dying.

**Step 2: Verify by hand**

Call `node` directly, not `npm run dev` — `npm run` prints its own `> cata-centavo@0.0.0 dev` banner to **stdout**, which would pollute the one check whose entire purpose is proving nothing but JSON-RPC reaches stdout.

A `tools/list` before `initialize` is not a legal MCP exchange, so send the full handshake:

```bash
nvm use
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | node src/bin/cata-centavo.ts 2>/dev/null
```

Expected: two JSON-RPC responses on stdout, the second listing three tools, and **nothing else**. Run it again without `2>/dev/null` to confirm every log line went to stderr.

Then the same pipeline with the credentials deliberately unset:

```bash
printf '%s\n' '…same three lines…' | env -u PLUGGY_CLIENT_SECRET node src/bin/cata-centavo.ts 2>/dev/null
```

Expected: the server still starts and still lists three tools. Piping input matters — without stdin the process blocks forever and proves nothing.

**Step 3: Full validation**

```bash
npm run typecheck && npm run lint && npm run deps && npm test && npm run build
```

**Step 4: Commit**

```bash
git add src/bin/cata-centavo.ts
git commit -m "feat: serve the MCP server over stdio"
```

---

## Task 15: The wrapper and `.mcp.json`

**Files:**
- Create: `scripts/mcp-dev.sh` (mode 0755)
- Create: `.mcp.json`

`.gitignore:22` is already `.env.*`, so `.env.local` is ignored today. Do not add a redundant line.

**Step 1: Write the wrapper**

```bash
#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# shellcheck disable=SC1090
[ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ] && . "${NVM_DIR:-$HOME/.nvm}/nvm.sh"

wanted="$(cat "$here/.nvmrc")"
if ! nvm use --silent "$wanted" >/dev/null 2>&1; then
  echo "cata-centavo: node $wanted is required. Run 'nvm install' in $here." >&2
  exit 1
fi

# Fill only what the environment did not supply. An MCP client may pass a
# variable through as an empty string, which must not count as "set".
if [ -f "$here/.env.local" ]; then
  while IFS='=' read -r key value; do
    case "$key" in ''|\#*) continue ;; esac
    value="${value%\"}"; value="${value#\"}"
    if [ -z "${!key:-}" ]; then export "$key=$value"; fi
  done < "$here/.env.local"
fi

exec node "$here/src/bin/cata-centavo.ts" "$@"
```

Two details are deliberate. `nvm use` is given the version **explicitly** rather than left to read `.nvmrc` from `$PWD` — the script never `cd`s, and an MCP client spawning it from another directory would otherwise get a confusing failure or, worse, a silently different Node. And the file is read line by line rather than sourced with `set -a`, because sourcing overwrites variables the environment already supplied, which is the opposite of what Step 3 requires and of what the design specifies (`: "${VAR:=$FROM_FILE}"` semantics).

The explicit nvm failure matters: without it a wrong Node dies with `ERR_UNKNOWN_FILE_EXTENSION`, which tells you nothing.

```bash
chmod +x scripts/mcp-dev.sh
```

**Step 2: Write `.mcp.json`**

```json
{
  "mcpServers": {
    "cata-centavo": {
      "command": "${CLAUDE_PROJECT_DIR}/scripts/mcp-dev.sh",
      "env": {
        "PLUGGY_CLIENT_ID": "${PLUGGY_CLIENT_ID:-}",
        "PLUGGY_CLIENT_SECRET": "${PLUGGY_CLIENT_SECRET:-}",
        "PLUGGY_ITEM_IDS": "${PLUGGY_ITEM_IDS:-}",
        "CATA_CENTAVO_LOG_LEVEL": "${CATA_CENTAVO_LOG_LEVEL:-info}"
      }
    }
  }
}
```

This file is committed to a **public** repository. It holds no secret — only `${VAR}` expansion.

Two details are load-bearing. The `:-` defaults: a bare `${PLUGGY_CLIENT_SECRET}` with the variable unset is an expansion *failure*, not an empty string, and a server entry that fails to expand may never spawn — which means no server, no tools, and none of the readable `isError` Task 13 exists to produce. And `CATA_CENTAVO_LOG_LEVEL` is the name `src/logging.ts:32` actually reads; `LOG_LEVEL` is read nowhere in `src/`.

The empty defaults are also why the wrapper must treat empty as unset: they arrive as `""`, and a wrapper that only checked "is it defined" would let them shadow `.env.local` silently.

**Step 3: Verify**

```bash
./scripts/mcp-dev.sh --version     # prints the version, on stderr
```

Then create a `.env.local` with real credentials and check both directions:

- shell variables **unset** → the server sees the credentials from the file
- shell variables **set to different values** → the shell wins
- shell variables set to the **empty string** → the file wins

The third is the case the `:-` defaults create, and the one a naive wrapper gets wrong.

**Step 4: Commit**

```bash
git add scripts/mcp-dev.sh .mcp.json
git commit -m "feat: wire the dev server into a local Claude Code session"
```

---

## Task 16: The live acceptance test

Not automated. This is the acceptance test for the phase as a whole.

**Step 1:** Restart Claude Code in this directory and approve the project-scoped MCP server on first use.

**Step 2:** Ask it "quanto eu tenho?" and confirm:

- `getAccounts` returns the six accounts across the three connections
- connection A shows its stale `lastUpdatedAt` — the recon found it three days behind
- `getBalance` returns cash and owed as separate figures, and no combined total
- `getBalanceByAccount` on one account matches that bank's own app

**Step 3:** Check the log file under `XDG_STATE_HOME` and confirm the correlation ids line up per call and that no `clientSecret` or JWT appears at any level.

**Step 4:** Empty the credentials in `.env.local`, reconnect, and confirm the tools still list and the first call names the missing variable.

---

## Task 17: Record the amendments to the ADR and the PRD

`CLAUDE.md` says the ADR is the source of truth and wins over anything that disagrees with it. This phase disagrees with it in three places, and leaving that unrecorded means the next person reads a document that promises things this phase deliberately did not build.

**Files:**
- Modify: `docs/adr/0001-stack-and-architecture.md` — §15 Phase 1, and §14.1
- Modify: `docs/prd.md` — the open decisions section

**Step 1: Amend the ADR**

Following the file's existing amendment convention (a marked block, dated, citing the evidence):

- **§15 Phase 1** no longer includes the lazy cache path or the 7-day freshness rule. Cite the recon: `isOpenFinance: false`, `PATCH /items/{id}` refused, one connection stalled three days with no diagnosable cause. Freshness is reported per connection instead of controlled.
- **§14.1** gains whatever Task 0 decided about `/investments` and `/loans`, and the note that an unrecognized account `type` is a parse failure rather than a default.

**Step 2: Amend the PRD**

- Open decision **#1** (cache freshness by range) no longer blocks Phase 1 — *range* is a property of transactions, and it moves to Phase 2.
- Open decision **#2** (camelCase vs snake_case) is closed: camelCase.
- Open decision **#3** (`isError` vs protocol error) is closed for the failure classes Phase 1 reaches: per tool, aggregate versus listing.

Cite `docs/plans/2026-07-26-phase-1-accounts-and-balances-design.md` for the reasoning rather than repeating it.

**Step 3: Commit**

```bash
git add docs/adr/0001-stack-and-architecture.md docs/prd.md
git commit -m "docs: record the Phase 1 amendments to the ADR and PRD"
```

---

## Task 18: Mutation testing and the README

**Step 1: Run Stryker**

```bash
nvm use && npm run mutation
```

Takes about 50 seconds. It never fails the build.

**Step 2: Read the survivors**

This phase touched `src/core`, `src/pluggy` and `src/mcp/format.ts`, all three now in scope. A green suite proves the tests ran, not that they assert. For each survivor either write the missing assertion or suppress it with a reason:

```ts
// Stryker disable next-line ArithmeticOperator: <why this mutation is not a real defect>
```

Pay attention to survivors in `toCents`, `prune` and `summarize` — those are the three functions where a surviving mutant is a financial bug that shipped.

**Step 3: Update the README**

One sentence, in the section that already has to say it about the cache: under `CATA_CENTAVO_LOG_LEVEL=debug` the log file holds financial data.

Run the prose through the `humanizer` skill — the README is prose, and `CLAUDE.md` exempts designs and plans from that but not the README.

**Step 4: Final validation**

```bash
npm run typecheck && npm run lint && npm run deps && npm test && npm run build
```

**Step 5: Commit**

Name the files. A blanket `git add src/ tests/` sweeps in whatever else happens to be dirty, and `CLAUDE.md` says do not commit unless asked.

```bash
git add README.md <the specific test files you changed>
git commit -m "test: close the mutation survivors from Phase 1"
```

---

## What this phase deliberately does not do

Carry these forward rather than solving them here:

- **Cache freshness by range** — Phase 2, where a date range first exists.
- **Why a connection returns zero accounts** — Phase 1 reports the fact; PRD Phase 5 owns the consent state that explains it.
- **`/investments` and `/loans`** — Task 0 decides between the two branches the design specifies. If they are absent, `invested` and `loans` are omitted and the PRD's acceptance line about invested figures is recorded as unfulfilled with evidence rather than faked.
- **A fixtures policy** — PRD open decision #6 is still open. Task 0 works around it by anonymizing at capture.

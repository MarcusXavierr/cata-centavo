# Credit Utilization Is Not a Bill — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Stop `getAccounts`, `getBalanceByAccount` and `getBalance` from presenting a credit card's used limit as if it were the card's bill, and fix the two secondary defects the investigation surfaced along the way.

**Architecture:** Nothing about how the number is fetched changes — `src/pluggy/mapper.ts:91` already passes Pluggy's `account.balance` through verbatim, which is correct. What changes is the vocabulary around it: the domain field is renamed from `balanceCents` to `usedCreditCents` for credit accounts, the MCP output field from `balance` to `usedCredit`, and three tool descriptions stop using the word "bill". Two independent fixes ride along: `credit.limit` starts preferring Pluggy's `customizedLimitAmount`, and `toDate` stops being able to produce an `Invalid Date` that crashes the protocol.

**Tech Stack:** Node 24 with native type stripping, `node --test`, zod at the Pluggy boundary, Stryker for mutation testing. No new dependencies.

---

## Why this is being done

`getAccounts` reported R$ 9.170,89 as the Santander Platinum bill and R$ 98,52 as the Nubank gold bill. The real open bills, read from the bank apps on 2026-07-26, are **R$ 6.042,44** and **R$ 42,92**.

A read-only probe against Pluggy that day settled the cause. `account.balance` on an Open Finance credit card is the **used credit limit at the moment of the request**, not any bill. The `disaggregatedCreditLimits` payload confirms it exactly: the Platinum's `CREDITO_A_VISTA` line carries `usedAmount: 9170.89`, identical to `balance`; the gold's carries `usedAmount: 98.52`.

The mapper is right and the decision was deliberate — `docs/research/2026-07-26-phase-1-probe.md:23-25` already recorded that `balance` is an "open/used card balance, not the user's current invoice total". `docs/adr/0001-stack-and-architecture.md:580` says it too: *"on `CREDIT` it is the open unpaid bill — and on regulated Open Finance connectors, the used limit."* All three connections are connector 200, so it is always the second case. The tool descriptions kept only the first half of that sentence.

**So this plan makes the tools truthful, not more capable.** It does not compute the real bill. That needs `/bills` plus per-connector installment reconciliation and is Phase 4 work — see "What this plan deliberately does not do" at the end, which carries the findings the next session will need.

Why the confusion looked like mixed months: within one account object, `balance` describes right now, while `creditData.balanceDueDate` (`2026-07-15`) and `creditData.minimumPayment` (`1304.66`, identical to the 15/07 bill's `minimumPaymentAmount`) describe the last closed cycle. We publish one period's value under the other period's date.

---

## Task 1: Rename the domain field to `usedCreditCents`

The name is what misleads. A reader of `account.balanceCents` on a credit card has no reason to suspect it is a utilization figure.

**Files:**
- Modify: `src/core/account.ts:15-28`
- Modify: `src/core/balance.ts:39-59`
- Modify: `src/pluggy/mapper.ts:83-96`
- Modify: `src/mcp/tools/accounts.ts:144-157`
- Test: `tests/core/balance.test.ts`, `tests/pluggy/mapper.test.ts`, `tests/mcp/tools/accounts.test.ts`, `tests/mcp/tools/balance.test.ts`

**Step 1: Read the current shape**

Run: `nvm use && npm run typecheck`
Expected: PASS. This is your baseline — everything must be green before you start.

**Step 2: Rename the field on the domain type**

In `src/core/account.ts`, the `Account` type currently has one monetary field used for every account type:

```ts
readonly balanceCents: number;
```

Replace it with a name that is honest for both cases, and document the split:

```ts
/**
 * Money in the account, in cents. On `BANK` this is available funds. On
 * `CREDIT` from an Open Finance connector it is the **used credit limit at
 * request time**, which is neither the closed bill nor the open one — see
 * `docs/plans/2026-07-26-credit-utilization-not-a-bill.md`.
 */
readonly amountCents: number;
```

`amountCents` rather than `usedCreditCents`, because the field is shared with `BANK` accounts where "used credit" is meaningless. The docblock carries the per-type meaning.

**Step 3: Follow the type errors**

Run: `npm run typecheck`
Expected: FAIL, with one error per site that reads `balanceCents`. Fix each to `amountCents`. The sites are `src/core/balance.ts:42,45,48,52`, `src/pluggy/mapper.ts:91`, `src/mcp/tools/accounts.ts:152`.

**Step 4: Fix the tests the same way**

Run: `npm test`
Expected: FAIL on the test files that construct `Account` literals. Rename `balanceCents` to `amountCents` in each. Do not change any expected *value* in this task — only the key.

**Step 5: Verify the whole gate**

Run: `npm run typecheck && npm run lint && npm run deps && npm test`
Expected: all PASS, with the same number of tests as in Step 1.

**Step 6: Commit**

```bash
git add src/core/account.ts src/core/balance.ts src/pluggy/mapper.ts src/mcp/tools/accounts.ts tests/
git commit -m "refactor: rename Account.balanceCents to amountCents"
```

---

## Task 2: Rename the MCP output field for credit accounts

**Files:**
- Modify: `src/mcp/tools/accounts.ts:144-157`
- Test: `tests/mcp/tools/accounts.test.ts`

**Step 1: Write the failing test**

A credit account's payload must not carry a key called `balance`, and must carry `usedCredit`. In `tests/mcp/tools/accounts.test.ts`, add to the existing suite:

```ts
it("publishes a credit card's figure as usedCredit, never as balance", async () => {
  const result = await handleGetAccounts(depsWithCreditCard());
  const account = firstAccount(result);

  assert.equal(account.usedCredit, "98.52");
  assert.equal("balance" in account, false);
});

it("still publishes a bank account's figure as balance", async () => {
  const result = await handleGetAccounts(depsWithBankAccount());
  const account = firstAccount(result);

  assert.equal(account.balance, "5.73");
  assert.equal("usedCredit" in account, false);
});
```

Reuse the file's existing helpers for building deps and parsing the JSON text payload rather than inventing new ones — look at how the neighbouring tests do it and follow that. If no `firstAccount` helper exists, write one small local helper that parses `result.content[0].text` and returns `accounts[0]`.

**Step 2: Run it to make sure it fails**

Run: `node --test tests/mcp/tools/accounts.test.ts`
Expected: FAIL — `account.usedCredit` is `undefined` and `"balance" in account` is `true`.

**Step 3: Implement the minimal change**

In `src/mcp/tools/accounts.ts`, `formatAccount` currently emits one key for every type:

```ts
balance: toDecimal(account.amountCents),
```

Make the key depend on the type. `prune` already strips nulls, so the unused key disappears on its own:

```ts
...(account.type === ACCOUNT_TYPES.credit
  ? { usedCredit: toDecimal(account.amountCents) }
  : { balance: toDecimal(account.amountCents) }),
```

Import `ACCOUNT_TYPES` from `../../core/account.ts` — the file already imports the types from there, so extend that import rather than adding a second one.

**Step 4: Run the tests**

Run: `node --test tests/mcp/tools/accounts.test.ts`
Expected: PASS.

**Step 5: Full gate**

Run: `npm run typecheck && npm run lint && npm run deps && npm test`
Expected: all PASS.

**Step 6: Commit**

```bash
git add src/mcp/tools/accounts.ts tests/mcp/tools/accounts.test.ts
git commit -m "feat: publish credit utilization as usedCredit, not balance"
```

---

## Task 3: Rewrite the three tool descriptions

Descriptions are the only discovery surface a model gets, and these three actively assert the wrong thing. Run the final wording through the `humanizer` skill before committing — this is prose, and CLAUDE.md asks for it.

**Files:**
- Modify: `src/mcp/tools/accounts.ts:20-34`
- Modify: `src/mcp/tools/balance.ts:18-24`
- Test: `tests/mcp/tools/accounts.test.ts`, `tests/mcp/tools/balance.test.ts`

**Step 1: Write the failing test**

The point is that no description may promise a bill. Add one table test that covers all three:

```ts
it("never describes a credit figure as a bill", () => {
  const descriptions = [
    GET_ACCOUNTS_DESCRIPTION,
    GET_BALANCE_BY_ACCOUNT_DESCRIPTION,
    GET_BALANCE_DESCRIPTION,
  ];

  for (const description of descriptions) {
    assert.doesNotMatch(description, /\bbill\b/i);
    assert.doesNotMatch(description, /\bdebt\b/i);
  }
});
```

The three constants are currently module-private. Export them so the test can read them — that is a smaller change than asserting against a registered server's metadata, and it keeps the assertion on the exact string that ships.

**Step 2: Run it to make sure it fails**

Run: `node --test tests/mcp/tools/accounts.test.ts`
Expected: FAIL on `GET_ACCOUNTS_DESCRIPTION` (contains "unpaid bill") and on `GET_BALANCE_DESCRIPTION` (contains "debt totals").

**Step 3: Rewrite `GET_ACCOUNTS_DESCRIPTION`**

Keep the three-part template from CLAUDE.md. The `Returns:` line has to state what the credit figure is *and* what it is not, because a model that only learns "it is not a bill" will still reach for it when asked about one:

```ts
export const GET_ACCOUNTS_DESCRIPTION = `Lists every account across the configured bank connections.

Use this tool when:
- You need an account map before inspecting one account or filtering financial activity.
- You need to see which configured connections could not provide account data.

Returns: Per-account figures in different units. A BANK account reports \`balance\`, the money available. A credit card reports \`usedCredit\`, how much of its limit is currently taken — this mixes the cycle in progress with instalments not yet charged, so it is not what the card owes this month and does not match the statement in a banking app. No tool here reports a card's statement amount.`;
```

**Step 4: Rewrite `GET_BALANCE_BY_ACCOUNT_DESCRIPTION`**

```ts
export const GET_BALANCE_BY_ACCOUNT_DESCRIPTION = `Gets the current figures and details for one account.

Use this tool when:
- You need one account's numbers and already have its ID from getAccounts.
- You need that account's credit limit and cycle dates.

Returns: For a BANK account, its balance. For a credit card, \`usedCredit\` — the portion of the limit currently taken, which is not the amount owed for the month. Also the currency, type, credit limit and cycle dates when applicable, and when the connection last supplied data.`;
```

Note the summary line changed from "balance and details" to "figures and details", because the tool no longer returns a thing called a balance for every account.

**Step 5: Rewrite `GET_BALANCE_DESCRIPTION`**

```ts
export const GET_BALANCE_DESCRIPTION = `Gets consolidated figures across all configured bank connections.

Use this tool when:
- You need total money available without mixing it with what cards have taken.
- You need to know when each connection last supplied its account data.

Returns: \`cash\`, the money available across bank accounts, and \`creditUsed\`, the limit currently taken across cards — never added together, because they are not the same unit. Investment and loan totals when reported, plus the currency, how many accounts were counted, and each source's update time.`;
```

**Step 6: Run the tests**

Run: `node --test tests/mcp/tools/accounts.test.ts tests/mcp/tools/balance.test.ts`
Expected: PASS.

**Step 7: Full gate, then commit**

```bash
npm run typecheck && npm run lint && npm run deps && npm test
git add src/mcp/tools/accounts.ts src/mcp/tools/balance.ts tests/mcp/
git commit -m "docs: stop describing credit utilization as a bill"
```

---

## Task 4: Rename `owed` to `creditUsed` in the consolidated summary

Task 3's new `GET_BALANCE_DESCRIPTION` promises a field called `creditUsed`. This task makes it true. Keep the aggregation itself — summing utilization across cards is a meaningful number; only the label was wrong.

**Files:**
- Modify: `src/core/balance.ts:3-10,16-23,29-59,61-70`
- Modify: `src/mcp/tools/balance.ts` (the response shaping around line 96)
- Test: `tests/core/balance.test.ts`, `tests/mcp/tools/balance.test.ts`

**Step 1: Write the failing test**

In `tests/mcp/tools/balance.test.ts`:

```ts
it("labels the card total creditUsed, not owed", async () => {
  const result = await handleGetBalance(depsWithCashAndCard());
  const summary = parsePayload(result);

  assert.equal(summary.creditUsed, "9269.41");
  assert.equal("owed" in summary, false);
});
```

**Step 2: Run it to make sure it fails**

Run: `node --test tests/mcp/tools/balance.test.ts`
Expected: FAIL — the key is still `owed`.

**Step 3: Rename through the layers**

In `src/core/balance.ts`, rename `owedCents` to `creditUsedCents` in `Summary`, in the internal `Totals` type, in the `CREDIT` branch of `sumBalances`, and in `createSummary`. Then rename the output key in `src/mcp/tools/balance.ts`.

**Step 4: Run the tests**

Run: `npm test`
Expected: PASS after renaming the key in `tests/core/balance.test.ts` too.

**Step 5: Full gate, then commit**

```bash
npm run typecheck && npm run lint && npm run deps && npm test
git add src/core/balance.ts src/mcp/tools/balance.ts tests/
git commit -m "refactor: rename owed to creditUsed in the balance summary"
```

---

## Task 5: Add the fixture that distinguishes utilization from the subtraction

This is the test-coverage hole that let the bug live. `tests/fixtures/accounts-credit.json` was captured from the sandbox card, where `balance` (265.50) happens to equal `creditLimit - availableCreditLimit` (3200 − 2934.50). So no current test can tell the two apart, and swapping one for the other keeps the suite green.

**Files:**
- Create: `tests/fixtures/accounts-credit-customized-limit.json`
- Test: `tests/pluggy/mapper.test.ts`

**Step 1: Create the fixture**

Modelled on the real Nubank gold, with synthetic identifiers because the repo is public. The load-bearing property: `balance` must **not** equal `creditLimit - availableCreditLimit`.

```json
{
  "total": 1,
  "totalPages": 1,
  "page": 1,
  "results": [
    {
      "id": "account-credit-customized-fixture",
      "itemId": "connection-fixture",
      "type": "CREDIT",
      "subtype": "CREDIT_CARD",
      "name": "Synthetic Customized Limit Card",
      "marketingName": null,
      "balance": 98.52,
      "currencyCode": "BRL",
      "bankData": null,
      "creditData": {
        "level": "GOLD",
        "brand": "MASTERCARD",
        "brandAdditionalInfo": null,
        "balanceCloseDate": null,
        "balanceDueDate": "2026-07-15",
        "availableCreditLimit": 2001.48,
        "balanceForeignCurrency": null,
        "minimumPayment": 56.8248,
        "creditLimit": 5450,
        "isLimitFlexible": false,
        "holderType": null,
        "status": "ACTIVE",
        "disaggregatedCreditLimits": [
          {
            "lineName": "CREDITO_A_VISTA",
            "usedAmount": 98.52,
            "limitAmount": 5450,
            "availableAmount": 2001.48,
            "customizedLimitAmount": 2100,
            "consolidationType": "CONSOLIDADO",
            "creditLineLimitType": "LIMITE_CREDITO_TOTAL",
            "identificationNumber": "0000",
            "isLimitFlexible": false,
            "usedAmountCurrencyCode": "BRL",
            "limitAmountCurrencyCode": "BRL",
            "availableAmountCurrencyCode": "BRL",
            "customizedLimitAmountCurrencyCode": "BRL"
          }
        ],
        "additionalCards": null
      },
      "owner": null,
      "number": "0000",
      "taxNumber": null,
      "createdAt": "2026-01-01T00:00:00.000Z",
      "updatedAt": "2026-01-01T00:00:00.000Z"
    }
  ]
}
```

**Step 2: Write the failing test**

In `tests/pluggy/mapper.test.ts`, next to the existing credit-mapping tests:

```ts
it("reports the utilization Pluggy sent, not the limit subtraction", () => {
  const wire = accountFixture("accounts-credit-customized-limit");
  const account = toAccount(wire, conn);

  assert.equal(account.amountCents, 9852);
  assert.notEqual(account.amountCents, 344852); // creditLimit - availableCreditLimit
});
```

The second assertion looks redundant and is not: it is the one that fails if someone "simplifies" the mapper into the subtraction, and it documents why the fixture exists.

**Step 3: Run it**

Run: `node --test tests/pluggy/mapper.test.ts`
Expected: PASS immediately — the mapper is already correct. This test is a regression guard, not a red-green cycle. Confirm it guards anything by temporarily changing `src/pluggy/mapper.ts:91` to the subtraction, re-running (must FAIL), then reverting.

**Step 4: Commit**

```bash
git add tests/fixtures/accounts-credit-customized-limit.json tests/pluggy/mapper.test.ts
git commit -m "test: pin credit utilization against the limit subtraction"
```

---

## Task 6: Prefer `customizedLimitAmount` for the reported limit

This is the inconsistency that first drew attention. The gold reports `creditLimit: 5450` and `availableCreditLimit: 2001.48`, which do not reconcile with a utilization of 98.52. The reason is in `disaggregatedCreditLimits`: the cardholder lowered the limit to `customizedLimitAmount: 2100`, and 2100 − 98.52 = 2001.48 exactly. We publish the bank's headline limit next to an available figure computed from the customized one, so the two contradict each other.

The Platinum has no customization (`customizedLimitAmount` equals `creditLimit`), which is why it reconciles.

**Files:**
- Modify: `src/pluggy/wire.ts:63-71`
- Modify: `src/pluggy/mapper.ts:106-118`
- Test: `tests/pluggy/mapper.test.ts`

**Step 1: Write the failing test**

```ts
it("prefers the cardholder's customized limit over the bank's headline limit", () => {
  const wire = accountFixture("accounts-credit-customized-limit");
  const account = toAccount(wire, conn);

  assert.equal(account.credit?.limitCents, 210000);
  assert.equal(account.credit?.availableLimitCents, 200148);
});

it("falls back to creditLimit when no customized limit is reported", () => {
  const wire = accountFixture("accounts-credit");
  const account = toAccount(wire, conn);

  assert.equal(account.credit?.limitCents, 320000);
});
```

**Step 2: Run it to make sure it fails**

Run: `node --test tests/pluggy/mapper.test.ts`
Expected: FAIL on the first test — `limitCents` is 545000, because `customizedLimitAmount` never reaches the mapper.

**Step 3: Declare the field in the wire schema**

`ACCOUNT`'s `creditData` object is in zod's default `strip` mode, so `disaggregatedCreditLimits` is discarded before anything can read it. Add only what is needed:

```ts
creditData: z
  .object({
    brand: z.string().nullish(),
    balanceCloseDate: z.string().nullish(),
    balanceDueDate: z.string().nullish(),
    availableCreditLimit: z.number().nullish(),
    creditLimit: z.number().nullish(),
    disaggregatedCreditLimits: z
      .array(
        z.object({
          creditLineLimitType: z.string().nullish(),
          customizedLimitAmount: z.number().nullish(),
        }),
      )
      .nullish(),
  })
  .nullish(),
```

**Step 4: Implement the preference**

In `src/pluggy/mapper.ts`, `toCreditDetails` currently reads `creditData.creditLimit` directly. Add a named function rather than inlining the search — CLAUDE.md wants a function where a comment would otherwise go:

```ts
/**
 * The limit a cardholder actually has, which is not always the one the bank
 * advertises. A customized limit shows up only in `disaggregatedCreditLimits`,
 * and `availableCreditLimit` is computed against it — so reporting
 * `creditLimit` beside it publishes two numbers that contradict each other.
 */
function toLimitCents(creditData: NonNullable<WireAccount["creditData"]>): number | null {
  const total = creditData.disaggregatedCreditLimits?.find(
    (line) => line.creditLineLimitType === "LIMITE_CREDITO_TOTAL",
  );

  return toNullableCents(total?.customizedLimitAmount ?? creditData.creditLimit);
}
```

Then in `toCreditDetails`, replace the `limitCents` line with `limitCents: toLimitCents(creditData),`.

Filter on `LIMITE_CREDITO_TOTAL` rather than taking the first entry: the real gold payload carries 20 lines, including per-modality ones (`CREDITO_PARCELADO`, `OUTROS` for cash withdrawal) whose customized amount is not the card's overall limit.

**Step 5: Run the tests**

Run: `node --test tests/pluggy/mapper.test.ts`
Expected: PASS.

**Step 6: Full gate, then commit**

```bash
npm run typecheck && npm run lint && npm run deps && npm test
git add src/pluggy/wire.ts src/pluggy/mapper.ts tests/pluggy/mapper.test.ts
git commit -m "fix: report the cardholder's customized credit limit"
```

---

## Task 7: Stop `toDate` from producing an `Invalid Date`

`toDate` at `src/pluggy/mapper.ts:124-126` does `new Date(value)` with no validity check. A non-ISO string becomes an `Invalid Date`, which survives all the way to `isoOrNull` at `src/mcp/tools/accounts.ts:175-177`, where `.toISOString()` throws `RangeError: Invalid time value`. That turns a bad date from one bank into a protocol-level crash — the exact inversion CLAUDE.md warns about, since the model never sees a protocol error and cannot recover from it.

The probe found a real trigger: `billForecastDate` arrives as the sentinel `"0001-01"` on Santander instalments that have no cycle assigned yet. Nothing reads that field today, but it shows Pluggy does emit unparseable date-ish strings.

**Files:**
- Modify: `src/pluggy/mapper.ts:124-126`
- Test: `tests/pluggy/mapper.test.ts`

**Step 1: Write the failing test**

```ts
it("drops an unparseable date instead of yielding an Invalid Date", () => {
  const wire = accountFixture("accounts-credit");
  assert.ok(wire.creditData);

  const account = toAccount(
    { ...wire, creditData: { ...wire.creditData, balanceDueDate: "0001-01" } },
    conn,
  );

  assert.equal(account.credit?.balanceDueDate, null);
});
```

**Step 2: Run it to make sure it fails**

Run: `node --test tests/pluggy/mapper.test.ts`
Expected: FAIL — `balanceDueDate` is an `Invalid Date` object, not `null`.

**Step 3: Implement**

```ts
function toDate(value: string | null | undefined): Date | null {
  if (value === null || value === undefined) return null;

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
```

Dropping the value rather than throwing is the right call here: a card whose due date we cannot parse is still a card whose limit and utilization we can report, and `ResponseShapeError` would cost the whole account.

**Step 4: Run the tests**

Run: `node --test tests/pluggy/mapper.test.ts`
Expected: PASS.

**Step 5: Full gate, then commit**

```bash
npm run typecheck && npm run lint && npm run deps && npm test
git add src/pluggy/mapper.ts tests/pluggy/mapper.test.ts
git commit -m "fix: drop unparseable Pluggy dates instead of crashing on them"
```

---

## Task 8: Mutation testing

**Step 1: Run it**

Run: `npm run mutation`
Expected: completes in roughly 50 seconds, never fails the build.

**Step 2: Read the survivors**

Two are worth hunting specifically:

- The `LIMITE_CREDITO_TOTAL` string literal in `toLimitCents`. If mutating it to `""` leaves tests green, the fixture's `disaggregatedCreditLimits` needs a second entry with a different `creditLineLimitType` and a different `customizedLimitAmount`, so picking the wrong line changes the result.
- The `Number.isNaN` guard in `toDate`. Should be covered by Task 7's test; if it survives, the assertion is testing the wrong thing.

For each survivor: write the missing assertion, or suppress it with a stated reason (`// Stryker disable next-line <Mutator>: why`). Do not chase coverage numbers.

**Step 3: Commit any new assertions**

```bash
git add tests/
git commit -m "test: close mutation survivors in credit limit mapping"
```

---

## End-to-end verification

**Step 1: Run the full gate in CI order**

```bash
nvm use
npm run typecheck && npm run lint && npm run deps && npm test && npm run build
```

All five must pass. `npm run typecheck` first is not optional — Node strips types without checking them, so without `tsc` this project has no type checking at all.

**Step 2: Drive the real MCP server**

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"getAccounts","arguments":{}}}' \
  | ./scripts/mcp-dev.sh
```

Confirm on the real data:

- Every `CREDIT` account carries `usedCredit` and no `balance`. Every `BANK` account carries `balance` and no `usedCredit`.
- The Nubank gold's `credit.limit` is now `"2100.00"`, and `2100.00 − 98.52 = 2001.48` matches its `availableLimit`. The Santander Platinum's limit stays `"27090.00"`, because it has no customized limit.
- No description in `tools/list` contains the word "bill" or "debt".
- A balance of exactly `0` still appears. `prune` must strip only null and undefined — a zero dropping out is a financial bug.

**Step 3: Confirm what is still wrong, on purpose**

The Santander still reports R$ 9.170,89 and the gold R$ 98,52. That is correct behaviour after this plan: those are utilization figures, now labelled as such. The real open bills are R$ 6.042,44 and R$ 42,92 and remain out of reach until Phase 4.

---

## What this plan deliberately does not do

It does not compute the bill, and you should not add it opportunistically while you are in here.

The reason is not that it is expensive. It is that the open bill is **not currently derivable on both cards**, and the two routes that do work each work on only one of them. The model is a single identity — `utilization = open bill + instalments not yet charged` — verified exactly on the Nubank gold (`98,52 − 55,60 = 42,92`). Computing the second term is the blocker: the gold materializes future instalments as transaction rows, the Santander leaves them implied and offers no stable key to group a payment plan. Shipping the rule that closes one card would be the Go implementation's declared-but-never-read filter all over again: green, and wrong.

**The full capture lives in `docs/research/2026-07-26-open-bill-probe.md`** — the two acceptance numbers, the rejected hypotheses with their figures, the four open design questions, and the API traps already paid for (relative `next` cursor, rejected `pageSize`, the `"0001-01"` sentinel, UTC date comparison, four-decimal money). Read that before starting Phase 4, not this plan.

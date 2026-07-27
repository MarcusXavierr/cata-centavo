# Phase 2 — transactions: implementation plan

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task.

**Goal:** Ship `getTransactions`, `listTransactions` and `getTransactionDetails`, backed by the first real `cache.db` table and a cursor walk over `GET /v2/transactions`.

**Architecture:** Pluggy is reached through `src/pluggy/`, whose cursor walk returns our `Transaction` domain type with the sign already normalized. Every filtering, grouping and roll-up rule lives in `src/core/`, pure and I/O-free. `src/storage/transactions.ts` is a typed relational cache whose one write method is synchronous and convergent. `src/mcp/` registers three tools and receives everything by injection; only `src/bin/` constructs infrastructure.

**Tech Stack:** Node 24 (native TypeScript stripping), `@modelcontextprotocol/sdk` ^1.29.0, `zod` ^4.4.3, `node:sqlite`, `pino`, `node --test`, Stryker.

**Design:** `docs/plans/2026-07-26-phase-2-transactions-design.md`. **Read it before Task 1.** Where this plan and the design disagree, the design wins.

---

## Before you start

Every command block assumes you have run `nvm use` in that shell. Node 18 is this machine's default and it fails misleadingly: one test file dies with `ERR_UNKNOWN_FILE_EXTENSION`, and `npm test` reports `# tests 0` and exits 0 — a green run that executed nothing.

```bash
nvm use    # reads .nvmrc → v24.15.0
node -v    # must print v24.15.0
```

**The validation sequence, in this order, after every task. No task skips it, including the ones that only add types:**

```bash
npm run typecheck && npm run lint && npm run deps && npm test
```

**Read `docs/plans/2026-07-26-phase-1-accounts-and-balances-plan.md` § "Before you start"** for the compiler flags that bite (`erasableSyntaxOnly`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) and the size sensors. All of it still applies. Not repeated here.

**Match each file's existing idiom.** `tests/pluggy/mapper.test.ts` and `tests/storage/db.test.ts` are `describe`/`it`; `tests/pluggy/client.test.ts` is `test`. Read the top of a file before appending to it. Fixtures are loaded with `new URL("../fixtures/x.json", import.meta.url)`, not a bare path.

**Seven things specific to this phase:**

1. **Money never touches a JS float.** `toCents` in `src/pluggy/mapper.ts:81` already parses the decimal representation with BigInt and rounds half away from zero. Reuse it. Never write `Math.round(value * 100)` — the design records why that was rejected.
2. **`node:sqlite` is synchronous.** A `BEGIN` left open across an `await` swallows the next transaction with `SQLITE_ERROR: cannot start a transaction within a transaction`. Task 7 is written so no transaction ever spans a fetch, and Task 9 depends on that.
3. **The row's `currency` is the *account's* currency**, not `transaction.currencyCode`. Getting this backwards makes every aggregate refuse on a wallet holding an international purchase. Task 5 covers it.
4. **Both sides of every date comparison go through `core/date.ts`.** Truncating the row in São Paulo and "today" in UTC reintroduces the bug the truncation exists to prevent. Task 4 covers it.
5. **No ternaries.** `no-restricted-syntax` against `ConditionalExpression` is a `warn` sensor added two commits ago (`a71b7d8`). It will not fail the build; it will make `.sensors/cli.sh check .` noisier on the phase that ignored it. Use `if`, or `// eslint-disable-line no-restricted-syntax -- reason`.
6. **The rate limiter is real in tests.** `sender()` defaults to `slidingWindowLimiter(options.clock)` with a *real* sleep, and the client-test harness uses a fixed clock — so any test driving more than 360 requests hangs forever, with no per-test timeout to save you. Inject `limiter: { acquire: async () => {} }`, as `tests/pluggy/client.test.ts:595` already does.
7. **Do not commit unless asked.** The commit step at the end of each task is written out ready to run, but ask first.

---

## Task 0: The `cache.db` schema

**Files:**
- Modify: `src/storage/migrations.ts`
- Test: `tests/storage/db.test.ts` (**extend — do not create a new file**)

**Step 1: Write the failing test**

The file already has `tableNames(db)` at line 33 and `userVersion(db)` at line 28. Use them; do not reinline the `sqlite_master` query. Add `CACHE_MIGRATIONS` and `targetVersion` to the existing import from `../../src/storage/`.

```ts
describe("the cache schema", () => {
  it("creates the transaction tables at the current version", () => {
    const db = openDatabase({ path: ":memory:", migrations: CACHE_MIGRATIONS, policy: "rebuild" });

    // "transaction_sync" sorts before "transactions": _ is 0x5F, s is 0x73.
    assert.deepEqual(tableNames(db), ["transaction_sync", "transactions"]);
    assert.equal(userVersion(db), targetVersion(CACHE_MIGRATIONS));
    db.close();
  });
});
```

**Step 2: Run it and watch it fail**

```bash
node --test tests/storage/db.test.ts
```

Expected: FAIL — the table list is empty, because `CACHE_MIGRATIONS` is `[]`.

**Step 3: Add the migration**

Replace the empty array in `src/storage/migrations.ts`, updating the existing docblock: `transactions` is no longer a future phase.

```ts
/**
 * Droppable: any mismatch is resolved by refetching from Pluggy (§10).
 *
 * **Bump `to` when the description normalizer changes.** `description_norm` is
 * written at insert and never recomputed, so appending an acquirer prefix to
 * `core/description.ts` leaves every cached row carrying the old value. The
 * rebuild policy is the re-derive pass, and this number is what triggers it.
 *
 * Under `rebuild`, `apply` replays every entry from 0 against a dropped file,
 * so a future `{to: 2}` is an additional statement rather than an `ALTER` — a
 * `CREATE TABLE transactions` in both entries would fail on the second.
 */
export const CACHE_MIGRATIONS: readonly Migration[] = [
  {
    to: 1,
    up: `
      CREATE TABLE transactions (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        connection_id TEXT NOT NULL,
        account_type TEXT NOT NULL,
        account_subtype TEXT,
        occurred_at TEXT NOT NULL,
        local_date TEXT NOT NULL,
        amount_cents INTEGER NOT NULL,
        currency TEXT NOT NULL,
        original_amount_cents INTEGER,
        original_currency TEXT,
        description TEXT NOT NULL,
        description_norm TEXT NOT NULL,
        category_id TEXT,
        document TEXT,
        counterparty_name TEXT,
        payment_method TEXT,
        mcc TEXT,
        bill_id TEXT,
        instalment_number INTEGER,
        instalment_total INTEGER,
        purchase_date TEXT
      );
      CREATE INDEX transactions_by_date ON transactions(local_date DESC, id DESC);
      CREATE INDEX transactions_by_account ON transactions(account_id, local_date DESC);

      CREATE TABLE transaction_sync (
        account_id TEXT PRIMARY KEY,
        connection_id TEXT NOT NULL,
        last_updated_at TEXT
      );
    `,
  },
];
```

**Step 4: Run the validation sequence**

```bash
node --test tests/storage/db.test.ts
npm run typecheck && npm run lint && npm run deps && npm test
```

**Step 5: Commit**

```bash
git add src/storage/migrations.ts tests/storage/db.test.ts
git commit -m "feat: add the transactions cache schema"
```

---

## Task 1: The `Transaction` domain type

**Files:**
- Create: `src/core/transaction.ts`
- Test: none of its own — a type with no behaviour. Task 5 exercises every field.

```ts
import type { AccountType } from "./account.ts";

/**
 * A transaction as we speak of it, which is not as Pluggy speaks of it (ADR §14.0).
 *
 * Two fields carry corrections that cost real money if reversed, both recorded
 * in `docs/plans/2026-07-26-phase-2-transactions-design.md`:
 *
 * - `amountCents` is **normalized**: negative is money out on every account
 *   type. Pluggy inverts the convention between BANK and CREDIT, so summing its
 *   raw `amount` across both partially cancels and lands on a believable wrong
 *   figure (ADR §14.1).
 * - `currency` is the **account's** currency, the unit `amountCents` is
 *   denominated in — never `transaction.currencyCode`. Pluggy pre-converts into
 *   the account's currency and parks the result in `amountInAccountCurrency`;
 *   the original lives in `originalAmountCents` and never enters a total.
 *
 * The detail fields below are extracted at map time rather than kept as raw
 * `paymentData` / `creditCardMetadata` blobs. A blob is unreachable from SQL
 * without `json_extract` over every row, which is what ADR §12.3 rules out for
 * Phase 3's `COALESCE` chain — and `getTransactionDetails` returns our field
 * names anyway (§14.0), so the blob would have been mapped on the way out too.
 */
export type Transaction = {
  readonly id: string;
  readonly accountId: string;
  readonly connectionId: string;
  readonly accountType: AccountType;
  readonly accountSubtype: string | null;
  /** The instant as reported, untruncated. */
  readonly occurredAt: string;
  /** The calendar day in `America/Sao_Paulo`, `YYYY-MM-DD`. What ranges filter on. */
  readonly localDate: string;
  readonly amountCents: number;
  readonly currency: string;
  /** Populated only when the purchase was made in another currency. */
  readonly originalAmountCents: number | null;
  readonly originalCurrency: string | null;
  readonly description: string;
  readonly descriptionNorm: string;
  /** The leaf id Pluggy reported, unrolled. The group is derived at read time. */
  readonly categoryId: string | null;
  /** Counterparty CPF/CNPJ, digits only (ADR §12.2). Absent on cards. */
  readonly document: string | null;
  readonly counterpartyName: string | null;
  readonly paymentMethod: string | null;
  /** Absent on bank rows. */
  readonly mcc: string | null;
  readonly billId: string | null;
  readonly instalmentNumber: number | null;
  readonly instalmentTotal: number | null;
  readonly purchaseDate: string | null;
};
```

**Validate and commit**

```bash
npm run typecheck && npm run lint && npm run deps && npm test
git add src/core/transaction.ts
git commit -m "feat: add the Transaction domain type"
```

---

## Task 2: São Paulo calendar days

Small, and it exists as its own module because **both sides of every date comparison must use it**. `core/aggregate.ts` needs "today" as badly as the mapper needs the row's day.

**Files:**
- Create: `src/core/date.ts`
- Create: `tests/core/date.test.ts`

**Step 1: Write the failing table test**

```ts
const CASES: readonly { readonly name: string; readonly instant: string; readonly expected: string }[] = [
  { name: "Brazilian midnight rendered as UTC keeps its own day", instant: "2026-06-20T03:00:00.000Z", expected: "2026-06-20" },
  { name: "a late evening purchase stays in the month it was made", instant: "2026-07-01T01:00:00.000Z", expected: "2026-06-30" },
  { name: "UTC midnight belongs to the previous Brazilian day", instant: "2026-06-01T00:00:00.000Z", expected: "2026-05-31" },
  { name: "midday is unambiguous", instant: "2026-06-15T15:00:00.000Z", expected: "2026-06-15" },
];

test("localDayOf", async (t) => {
  for (const { name, instant, expected } of CASES) {
    await t.test(name, () => {
      assert.equal(localDayOf(instant), expected);
    });
  }
});

test("localDayOf refuses a value that is not a date", () => {
  assert.throws(() => localDayOf("not-a-date"), /not-a-date/u);
});

test("todayIn reads the clock, not the system time", () => {
  const clock = fixedClock(new Date("2026-07-01T01:00:00.000Z"));

  // 22:00 on 30 June in São Paulo. Deriving "today" with toISOString().slice(0,10)
  // would return 2026-07-01 and move the evening's purchases into `upcoming`.
  assert.equal(todayIn(clock), "2026-06-30");
});
```

**Step 2–4: Red, implement, green**

```ts
const SAO_PAULO = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Sao_Paulo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * The calendar day an instant belongs to, in Brazil.
 *
 * Not UTC. Most transaction rows arrive as `T03:00:00.000Z`, which is Brazilian
 * midnight rendered in UTC and truncates correctly either way — but the recon
 * found the time component "is not uniform, some carry a real timestamp", and a
 * purchase at 22:00 BRT on 30 June is `2026-07-01T01:00Z`. Truncated in UTC it
 * lands in July and drops out of "quanto gastei em junho".
 *
 * (The opposite rule holds for a bill's `dueDate`, which the open-bill probe
 * says to compare on its UTC parts. Different field, different shape, Phase 4.)
 */
export function localDayOf(instant: string): string { ... }

/** Today, in the same units every stored `localDate` is in. */
export function todayIn(clock: Clock): string {
  return localDayOf(clock.now().toISOString());
}
```

`localDayOf` throws a `RangeError` on an unparseable input; `pluggy/mapper.ts` catches and rethrows it as a `ResponseShapeError` so a bad date reads as a wire problem, not a logic bug.

**Step 5: Commit**

```bash
git add src/core/date.ts tests/core/date.test.ts
git commit -m "feat: truncate dates to Brazilian calendar days"
```

---

## Task 3: Description normalization

ADR §12.5 calls this the highest-value unit test in the project. Write it as a **table test** — adding a prefix later must cost one line in the array.

**Files:**
- Create: `src/core/description.ts`
- Create: `tests/core/description.test.ts`

**Step 1: Write the failing table test**

```ts
const CASES: readonly { readonly name: string; readonly input: string; readonly expected: string }[] = [
  { name: "the ADR's own example", input: "PAG*DEIVYN LANCHES LTDA 03/12", expected: "DEIVYN LANCHES" },
  { name: "uppercases", input: "padaria bela vista", expected: "PADARIA BELA VISTA" },
  { name: "strips accents", input: "AÇOUGUE SÃO JOÃO", expected: "ACOUGUE SAO JOAO" },
  { name: "strips a PG * prefix", input: "PG *MERCADO CENTRAL", expected: "MERCADO CENTRAL" },
  { name: "strips a CIELO* prefix", input: "CIELO*POSTO IPIRANGA", expected: "POSTO IPIRANGA" },
  { name: "strips a REDE* prefix", input: "REDE*FARMACIA POPULAR", expected: "FARMACIA POPULAR" },
  { name: "strips a trailing instalment marker", input: "LOJA X 03/12", expected: "LOJA X" },
  { name: "strips a trailing sequence number", input: "SUPERMERCADO Y 000123", expected: "SUPERMERCADO Y" },
  { name: "collapses whitespace", input: "  LOJA    Z  ", expected: "LOJA Z" },
  { name: "strips one legal suffix", input: "DEIVYN LANCHES LTDA", expected: "DEIVYN LANCHES" },
  { name: "strips stacked legal suffixes", input: "LOJA LTDA ME", expected: "LOJA" },
  { name: "leaves a person's name intact", input: "Maria Silva Santos", expected: "MARIA SILVA SANTOS" },
  { name: "keeps a name ending in a short number", input: "POSTO 24 HORAS", expected: "POSTO 24 HORAS" },
  { name: "survives an empty string", input: "", expected: "" },
  { name: "survives a string that is entirely a prefix", input: "PAG*", expected: "" },
];

test("normalizeDescription", async (t) => {
  for (const { name, input, expected } of CASES) {
    await t.test(name, () => {
      assert.equal(normalizeDescription(input), expected);
    });
  }
});

test("normalizeDescription is idempotent", async (t) => {
  for (const { name, input } of CASES) {
    await t.test(name, () => {
      const once = normalizeDescription(input);
      assert.equal(normalizeDescription(once), once);
    });
  }
});
```

`"LOJA LTDA ME"` is the case that forces the fix: stripping at most one suffix per call makes the function non-idempotent, and a docblock claiming a property the code lacks is worse than no docblock.

**Step 2: Run it and watch it fail**

```bash
node --test tests/core/description.test.ts
```

**Step 3: Write the implementation**

```ts
/**
 * Payment acquirers that stamp themselves onto the merchant name.
 *
 * **This list is data, and it is expected to grow.** ADR §12.5 says to feed it
 * real cases as they appear rather than get it right the first time. Adding one
 * is one line here, one case in the table test, and a bump of `CACHE_MIGRATIONS`.
 */
const ACQUIRER_PREFIXES: readonly string[] = ["PAG*", "PG *", "PG*", "CIELO*", "REDE*", "STONE*", "MP *", "PAGSEGURO*"];

/** Corporate suffixes that carry no information about who was paid. */
const LEGAL_SUFFIXES: readonly string[] = ["LTDA", "ME", "EIRELI", "SA", "S/A", "EPP"];

const TRAILING_INSTALMENT = /\s+\d{1,2}\/\d{1,2}$/u;
const TRAILING_SEQUENCE = /\s+\d{5,}$/u;
```

`TRAILING_SEQUENCE` requires five digits, which is what keeps `POSTO 24 HORAS` intact while removing `000123`. If a real case needs four, add it to the table first and watch it fail.

`stripLegalSuffix` loops to a fixpoint rather than stripping once, so the idempotence the docblock claims is the idempotence the code has.

**Step 4–5: Validate and commit**

```bash
npm run typecheck && npm run lint && npm run deps && npm test
git add src/core/description.ts tests/core/description.test.ts
git commit -m "feat: normalize transaction descriptions"
```

---

## Task 4: The category roll-up

**Files:**
- Create: `src/core/taxonomy.ts`
- Create: `tests/core/taxonomy.test.ts`

`core/taxonomy.ts` is **pure and holds no module state.** Phase 1's design rejected process-global state inside a business rule by name; a module-level memo here would be that shape. The fetched response is cached in `pluggy/client.ts` (Task 6).

**Step 1: Write the failing test**

The fixture mirrors the real tree's three shapes: a two-level branch, the three-level Services → Education → University branch, and the 9-digit Insurance children whose parent is 8 digits.

```ts
const ENTRIES: readonly TaxonomyEntry[] = [
  { id: "07000000", parentId: null },
  { id: "07030000", parentId: "07000000" },
  { id: "07030100", parentId: "07030000" },
  { id: "20000000", parentId: null },
  { id: "200100000", parentId: "20000000" },
  { id: "05000000", parentId: null },
  { id: "05100000", parentId: "05000000" },
];

const CASES: readonly { readonly name: string; readonly leaf: string; readonly expected: string }[] = [
  { name: "a top-level id maps to itself", leaf: "07000000", expected: "07000000" },
  { name: "one level rolls up", leaf: "07030000", expected: "07000000" },
  { name: "three levels roll up transitively", leaf: "07030100", expected: "07000000" },
  { name: "a nine-digit child rolls up to its eight-digit parent", leaf: "200100000", expected: "20000000" },
  { name: "credit card payment rolls up into transfers", leaf: "05100000", expected: "05000000" },
];

test("buildRollup", async (t) => {
  const rollup = buildRollup(ENTRIES);

  for (const { name, leaf, expected } of CASES) {
    await t.test(name, () => {
      assert.equal(rollup.get(leaf), expected);
    });
  }
});

test("buildRollup never derives a parent by slicing an id", () => {
  const rollup = buildRollup(ENTRIES);

  // "200100000".slice(0, 8) is "20010000", which is not a category. A positional
  // rule works on 126 of the real tree's 130 entries and breaks on these four.
  assert.equal(rollup.get("200100000"), "20000000");
  assert.equal(rollup.has("20010000"), false);
});

test("buildRollup trusts parentId over any description", () => {
  // Three real entries under Loans and financing carry a parentDescription that
  // disagrees with their own parentId. parentId is the field to trust.
  const rollup = buildRollup([
    { id: "02000000", parentId: null },
    { id: "02010000", parentId: "02000000", parentDescription: "Something else entirely" },
  ]);

  assert.equal(rollup.get("02010000"), "02000000");
});

test("buildRollup rejects a root that is not one of our 22 categories", () => {
  assert.throws(() => buildRollup([{ id: "77000000", parentId: null }]), /77000000/u);
});

test("buildRollup rejects a parentId pointing at an entry that is not in the tree", () => {
  assert.throws(() => buildRollup([{ id: "07030000", parentId: "07000000" }]), /07000000/u);
});

test("buildRollup rejects a cycle rather than looping forever", () => {
  assert.throws(
    () =>
      buildRollup([
        { id: "07000000", parentId: "07030000" },
        { id: "07030000", parentId: "07000000" },
      ]),
    /cycle/iu,
  );
});

test("every top-level category is its own root", () => {
  const entries = Object.values(CATEGORIES).map((category) => ({ id: category.id, parentId: null }));
  const rollup = buildRollup(entries);

  for (const category of Object.values(CATEGORIES)) {
    assert.equal(rollup.get(category.id), category.id);
  }
});
```

**Step 2: Run it and watch it fail**

**Step 3: Write the implementation**

```ts
/**
 * One node of Pluggy's category tree, reduced to what the roll-up needs.
 * `parentDescription` is carried only so the type matches the wire shape; it is
 * deliberately never read — three real entries under Loans and financing carry
 * one that disagrees with their own `parentId` (ADR §12.4).
 */
export type TaxonomyEntry = {
  readonly id: string;
  readonly parentId: string | null;
  readonly parentDescription?: string | null;
};

/**
 * Maps every category id to its top-level ancestor, transitively.
 *
 * The tree is three levels deep in places, so a walk of one level loses the
 * leaves — and parents are used as categories in their own right alongside
 * their children, so a group-by that does not roll up scatters one concept
 * across several rows (ADR §12.4).
 *
 * Throws rather than guessing when the tree is malformed. A silently wrong
 * roll-up is a wrong number, which is the one thing this project refuses.
 */
export function buildRollup(entries: readonly TaxonomyEntry[]): ReadonlyMap<string, CategoryId> { ... }
```

`rootOf` walks `parentId` with a `seen` set for the cycle guard, throws when a `parentId` names an entry the tree does not contain, and throws when the root it reaches fails `isCategoryId`.

**Step 4–5: Validate and commit**

```bash
npm run typecheck && npm run lint && npm run deps && npm test
git add src/core/taxonomy.ts tests/core/taxonomy.test.ts
git commit -m "feat: roll categories up to their top-level ancestor"
```

---

## Task 5: The wire schemas

**Files:**
- Modify: `src/pluggy/wire.ts`
- Test: `tests/pluggy/wire.test.ts` (create — the pagination assertion needs one)

**Step 1: Write the failing test**

The one behaviour in this file worth a test of its own is the `/categories` page assertion, which the design states as a rule and which nothing else would catch.

```ts
test("the category page refuses to be one of several", () => {
  // /categories is still offset-paginated. Silently taking page one of several
  // is the failure ADR §14.2 spends a section on, in the one place it survives.
  assert.throws(() => parseCategoryPage({ results: [], total: 900, totalPages: 2, page: 1 }), /totalPages/u);
});

test("the category page accepts a single page", () => {
  assert.deepEqual(parseCategoryPage({ results: [], total: 0, totalPages: 1, page: 1 }), []);
});
```

**Step 2: Run and watch it fail**

**Step 3: Add the schemas**

Read the existing `ACCOUNT` and `ITEM` schemas first and match their style — including the exported `WireAccount` / `WireItem` type aliases, which is why `mapper.ts` never writes `z.infer` inline.

```ts
/**
 * Absence is signalled two different ways depending on nesting depth, and the
 * two are not interchangeable (ADR §14.3).
 *
 * Top-level transaction fields are always present and explicitly `null` — all
 * 23 keys on all 1751 rows of the recon, no key ever omitted and no value ever
 * `""`. Fields nested inside `creditCardMetadata` are **omitted entirely** when
 * absent, with zero explicit nulls. Hence `.nullable()` above and `.optional()`
 * below, which is also where `exactOptionalPropertyTypes` earns its place.
 */
export const CREDIT_CARD_METADATA = z.object({
  billId: z.string().optional(),
  installmentNumber: z.number().optional(),
  totalInstallments: z.number().optional(),
  cardNumber: z.string().optional(),
  payeeMCC: z.number().optional(),
  purchaseDate: z.string().optional(),
  feeType: z.string().optional(),
});

export const PAYMENT_DATA = z.object({
  receiver: z
    .object({
      name: z.string().optional(),
      documentNumber: z.object({ value: z.string().optional(), type: z.string().optional() }).optional(),
    })
    .nullish(),
  paymentMethod: z.string().nullish(),
});

export const TRANSACTION = z.object({
  id: z.string(),
  accountId: z.string(),
  date: z.string(),
  description: z.string(),
  descriptionRaw: z.string().nullish(),
  amount: z.number(),
  amountInAccountCurrency: z.number().nullish(),
  currencyCode: z.string().nullish(),
  category: z.string().nullish(),
  categoryId: z.string().nullish(),
  /** Parsed and deliberately dropped — see the design's "not in Phase 2". */
  status: z.string().nullish(),
  creditCardMetadata: CREDIT_CARD_METADATA.nullish(),
  paymentData: PAYMENT_DATA.nullish(),
});

export type WireTransaction = z.infer<typeof TRANSACTION>;

/**
 * The v2 envelope is two keys. **No `total`, no `totalPages`, no `page`** — the
 * offset-paginated shape `ACCOUNT_PAGE` uses is gone from this endpoint, and
 * with it the invariant §14.2 was built on. `next` is a relative query string
 * beginning with `?`, not a URL.
 */
export const TRANSACTION_PAGE = z.object({
  results: z.array(TRANSACTION),
  next: z.string().nullable(),
});

export const CATEGORY = z.object({
  id: z.string(),
  description: z.string(),
  descriptionTranslated: z.string().nullish(),
  parentId: z.string().nullish(),
  parentDescription: z.string().nullish(),
});
```

`.nullish()` throughout on the category fields, matching `ACCOUNT` and `ITEM`. The design's "always present and explicitly null" evidence is about `/v2/transactions`, measured over 1751 rows. Nothing measured `/categories` that way, and one omitted key on a schema that requires it hard-fails a fetch the error table escalates into refusing every total.

**Step 4–5: Validate and commit**

```bash
npm run typecheck && npm run lint && npm run deps && npm test
git add src/pluggy/wire.ts tests/pluggy/wire.test.ts
git commit -m "feat: add transaction and category wire schemas"
```

---

## Task 6: `toTransaction` — the four corrections

This is where the phase's money bugs live.

**Files:**
- Modify: `src/pluggy/mapper.ts`
- Test: `tests/pluggy/mapper.test.ts` (**extend — the file exists, and it is `describe`/`it`**)
- Create: `tests/fixtures/transactions-page.json` (hand-authored, synthetic)

**Step 1: Write the fixture**

Everything invented. Nothing copied from a capture.

```json
{
  "results": [
    {
      "id": "t-bank-1",
      "accountId": "acc-bank",
      "date": "2026-06-15T03:00:00.000Z",
      "description": "PIX ENVIADO MARIA SILVA",
      "descriptionRaw": null,
      "amount": -150.5,
      "amountInAccountCurrency": null,
      "currencyCode": "BRL",
      "category": "Transfers - PIX",
      "categoryId": "05020000",
      "status": "POSTED",
      "paymentData": {
        "receiver": { "name": "MARIA SILVA", "documentNumber": { "value": "123.456.789-00", "type": "CPF" } },
        "paymentMethod": "PIX"
      }
    },
    {
      "id": "t-card-1",
      "accountId": "acc-card",
      "date": "2026-06-20T03:00:00.000Z",
      "description": "PAG*DEIVYN LANCHES LTDA 03/12",
      "descriptionRaw": "PAG*DEIVYN LANCHES LTDA 03/12",
      "amount": 89.9,
      "amountInAccountCurrency": null,
      "currencyCode": "BRL",
      "category": "Food and drinks",
      "categoryId": "11000000",
      "status": "POSTED",
      "creditCardMetadata": {
        "billId": "bill-1",
        "payeeMCC": 5814,
        "installmentNumber": 3,
        "totalInstallments": 12,
        "purchaseDate": "2026-04-20"
      }
    },
    {
      "id": "t-card-foreign",
      "accountId": "acc-card",
      "date": "2026-06-21T03:00:00.000Z",
      "description": "STEAM PURCHASE",
      "descriptionRaw": null,
      "amount": 20.0,
      "amountInAccountCurrency": 100.0,
      "currencyCode": "USD",
      "category": "Digital services",
      "categoryId": "09000000",
      "status": "POSTED",
      "creditCardMetadata": { "billId": "bill-1", "payeeMCC": 5816 }
    },
    {
      "id": "t-card-late",
      "accountId": "acc-card",
      "date": "2026-07-01T01:00:00.000Z",
      "description": "PADARIA NOTURNA",
      "descriptionRaw": null,
      "amount": 12.0,
      "amountInAccountCurrency": null,
      "currencyCode": "BRL",
      "category": "Food and drinks",
      "categoryId": "11000000",
      "status": "POSTED",
      "creditCardMetadata": { "billId": "bill-1", "payeeMCC": 5812 }
    },
    {
      "id": "t-card-subcent",
      "accountId": "acc-card",
      "date": "2026-06-22T03:00:00.000Z",
      "description": "IOF",
      "descriptionRaw": null,
      "amount": 307.8891,
      "amountInAccountCurrency": null,
      "currencyCode": "BRL",
      "category": "Bank fees",
      "categoryId": "16000000",
      "status": "PENDING",
      "creditCardMetadata": { "billId": "bill-1", "feeType": "IOF" }
    }
  ],
  "next": null
}
```

**Step 2: Write the failing tests**

Parse the fixture **once**, at module scope, into a lookup. The file's existing `accountFixture` helper is the precedent; do not re-read and re-parse per case.

```ts
const WIRE: ReadonlyMap<string, WireTransaction> = new Map(
  TRANSACTION_PAGE.parse(
    JSON.parse(readFileSync(new URL("../fixtures/transactions-page.json", import.meta.url), "utf8")),
  ).results.map((row) => [row.id, row]),
);

function wireRow(id: string): WireTransaction {
  const found = WIRE.get(id);
  assert.ok(found, `fixture is missing ${id}`);
  return found;
}

const BANK_ACCOUNT: Account = {
  id: "acc-bank",
  connectionId: "conn-1",
  institution: "Test Bank",
  name: "Checking",
  type: "BANK",
  subtype: "CHECKING_ACCOUNT",
  amountCents: 100_000,
  currency: "BRL",
  lastUpdatedAt: new Date("2026-07-26T12:00:00.000Z"),
  credit: null,
};

const CARD_ACCOUNT: Account = { ...BANK_ACCOUNT, id: "acc-card", name: "Card", type: "CREDIT", subtype: "CREDIT_CARD" };

describe("toTransaction", () => {
  const SIGN_CASES: readonly { readonly name: string; readonly id: string; readonly account: Account; readonly cents: number }[] = [
    { name: "a bank debit stays negative", id: "t-bank-1", account: BANK_ACCOUNT, cents: -15_050 },
    { name: "a card purchase flips to negative", id: "t-card-1", account: CARD_ACCOUNT, cents: -8_990 },
    { name: "a foreign card purchase flips and converts", id: "t-card-foreign", account: CARD_ACCOUNT, cents: -10_000 },
  ];

  for (const { name, id, account, cents } of SIGN_CASES) {
    it(`normalizes the sign so money out is negative: ${name}`, () => {
      assert.equal(toTransaction(wireRow(id), account).amountCents, cents);
    });
  }

  it("denominates in the account's currency, not the purchase's", () => {
    const transaction = toTransaction(wireRow("t-card-foreign"), CARD_ACCOUNT);

    // The purchase was USD; the account is BRL. Storing "USD" here would make the
    // mixed-currency guard refuse every aggregate on a wallet holding one of these.
    assert.equal(transaction.currency, "BRL");
    assert.equal(transaction.originalCurrency, "USD");
    assert.equal(transaction.originalAmountCents, -2_000);
  });

  it("leaves the original blank on a domestic purchase", () => {
    const transaction = toTransaction(wireRow("t-card-1"), CARD_ACCOUNT);

    assert.equal(transaction.originalCurrency, null);
    assert.equal(transaction.originalAmountCents, null);
  });

  it("rounds sub-cent money through toCents rather than refusing", () => {
    // The open-bill probe found Nubank sending 307.8891. toCents rounds it half
    // away from zero over the decimal representation, without binary floats.
    assert.equal(toTransaction(wireRow("t-card-subcent"), CARD_ACCOUNT).amountCents, -30_789);
  });

  const DATE_CASES: readonly { readonly name: string; readonly id: string; readonly localDate: string }[] = [
    { name: "Brazilian midnight rendered as UTC", id: "t-card-1", localDate: "2026-06-20" },
    { name: "a late evening purchase", id: "t-card-late", localDate: "2026-06-30" },
  ];

  for (const { name, id, localDate } of DATE_CASES) {
    it(`truncates dates in São Paulo: ${name}`, () => {
      assert.equal(toTransaction(wireRow(id), CARD_ACCOUNT).localDate, localDate);
    });
  }

  const EXTRACTION_CASES: readonly {
    readonly name: string;
    readonly id: string;
    readonly account: Account;
    readonly expected: Partial<Transaction>;
  }[] = [
    {
      name: "a bank row carries a document and a payment method, and no card fields",
      id: "t-bank-1",
      account: BANK_ACCOUNT,
      expected: {
        document: "12345678900",
        counterpartyName: "MARIA SILVA",
        paymentMethod: "PIX",
        mcc: null,
        billId: null,
        instalmentNumber: null,
        // The leaf, unrolled. The roll-up is derived at read time, and storing it
        // would destroy the leaf the transfer exclusions in core/aggregate.ts need.
        categoryId: "05020000",
      },
    },
    {
      name: "a card row carries card fields and no document",
      id: "t-card-1",
      account: CARD_ACCOUNT,
      expected: {
        document: null,
        counterpartyName: null,
        mcc: "5814",
        billId: "bill-1",
        instalmentNumber: 3,
        instalmentTotal: 12,
        purchaseDate: "2026-04-20",
      },
    },
    {
      name: "an omitted nested key reads as null, not undefined",
      id: "t-card-foreign",
      account: CARD_ACCOUNT,
      expected: { instalmentNumber: null, instalmentTotal: null, purchaseDate: null },
    },
  ];

  for (const { name, id, account, expected } of EXTRACTION_CASES) {
    it(`extracts the detail fields: ${name}`, () => {
      const transaction = toTransaction(wireRow(id), account);

      for (const [key, value] of Object.entries(expected)) {
        assert.deepEqual(transaction[key as keyof Transaction], value, key);
      }
    });
  }

  it("refuses an account type that cannot reach this endpoint", () => {
    const investment: Account = { ...BANK_ACCOUNT, type: "INVESTMENT" };

    assert.throws(() => toTransaction(wireRow("t-bank-1"), investment), /INVESTMENT/u);
  });

  it("reports an unparseable date as a wire problem", () => {
    assert.throws(() => toTransaction({ ...wireRow("t-bank-1"), date: "nope" }, BANK_ACCOUNT), ResponseShapeError);
  });
});
```

**Step 3: Run and watch them fail**

**Step 4: Write the implementation**

```ts
/** Digits only, so punctuation cannot split one merchant into two (ADR §12.2). */
function toDigits(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  const digits = value.replace(/\D/gu, "");
  if (digits === "") {
    return null;
  }

  return digits;
}

function signFor(type: AccountType): 1 | -1 {
  switch (type) {
    case "BANK":
      return 1;
    case "CREDIT":
      // Pluggy inverts the convention here: a card debit arrives positive.
      return -1;
    default:
      throw new ResponseShapeError(`${type} accounts have no transaction feed on /v2/transactions`);
  }
}

/**
 * One Pluggy transaction, in our vocabulary, with the sign normalized.
 *
 * Takes the `Account` rather than its id because the sign flip is decidable
 * only from the account type, and `/v2/transactions?accountId=` does not return
 * it. `toAccount(account, connection)` establishes the same pattern.
 */
export function toTransaction(wire: WireTransaction, account: Account): Transaction {
  const sign = signFor(account.type);
  const foreign = wire.amountInAccountCurrency !== null && wire.amountInAccountCurrency !== undefined;

  let original: Pick<Transaction, "originalAmountCents" | "originalCurrency">;
  if (foreign) {
    original = { originalAmountCents: sign * toCents(wire.amount), originalCurrency: wire.currencyCode ?? null };
  } else {
    original = { originalAmountCents: null, originalCurrency: null };
  }

  return {
    ...original,
    id: wire.id,
    accountId: account.id,
    connectionId: account.connectionId,
    accountType: account.type,
    accountSubtype: account.subtype,
    occurredAt: wire.date,
    localDate: localDayOrThrow(wire.date),
    amountCents: sign * toCents(wire.amountInAccountCurrency ?? wire.amount),
    currency: account.currency,
    description: wire.description,
    descriptionNorm: normalizeDescription(wire.description),
    categoryId: wire.categoryId ?? null,
    document: toDigits(wire.paymentData?.receiver?.documentNumber?.value),
    counterpartyName: wire.paymentData?.receiver?.name ?? null,
    paymentMethod: wire.paymentData?.paymentMethod ?? null,
    mcc: wire.creditCardMetadata?.payeeMCC?.toString() ?? null,
    billId: wire.creditCardMetadata?.billId ?? null,
    instalmentNumber: wire.creditCardMetadata?.installmentNumber ?? null,
    instalmentTotal: wire.creditCardMetadata?.totalInstallments ?? null,
    purchaseDate: wire.creditCardMetadata?.purchaseDate ?? null,
  };
}
```

`if` rather than a ternary for the `original` pair, per the sensor added in `a71b7d8`. `amountInAccountCurrency ?? amount` is one line and it is the whole currency rule — the recon: *"non-null on exactly those 33 rows and null on all 1718 BRL rows… naively summing `amount` is a silent error of the §14.1 class."*

**Step 5: Validate and commit**

```bash
npm run typecheck && npm run lint && npm run deps && npm test
git add src/pluggy/mapper.ts tests/pluggy/mapper.test.ts tests/fixtures/transactions-page.json
git commit -m "feat: map Pluggy transactions into our normalized shape"
```

---

## Task 7: The cursor walk and `getCategories`

**Files:**
- Modify: `src/core/contracts.ts`
- Modify: `src/pluggy/client.ts`
- Modify: `tests/fakes/fake-bank.ts`
- Test: `tests/pluggy/client.test.ts` (**extend**)

**Everything in this task goes inside the `createPluggyClient` factory body.** `get()` is closure-local (`client.ts:27`), and so is `transport`. A top-level `async function walkTransactions()` cannot see either. The categories cache must be closure-local for the same reason plus a second one: at module scope it is shared across every client in the `node --test` process, which makes the "fetched once" test order-dependent — the exact failure mode the design cites when rejecting a memo inside `core/`.

**Step 1: Grow the contract**

In `src/core/contracts.ts`, add to `Bank`:

```ts
  /**
   * Every transaction on one account, walked to the end of the cursor.
   *
   * Takes the account rather than its id because normalization needs the type
   * (ADR §14.1's sign inversion), and the endpoint does not return it.
   */
  getTransactions(account: Account): Promise<readonly Transaction[]>;
  /** Pluggy's category tree. A public reference endpoint, cached per client. */
  getCategories(): Promise<readonly TaxonomyEntry[]>;
```

**Step 2: Write the failing tests**

`tests/pluggy/client.test.ts` already has `harness()` returning `{ client, fetch, ... }` and `BASE_URL = "https://api.test"`. Reuse both; do not invent a parallel `clientFor`. Add one helper, `pageResponder(pages)`, that answers `/v2/transactions` from a list and records urls.

```ts
const WALK_CASES: readonly {
  readonly name: string;
  readonly pages: readonly { readonly ids: readonly string[]; readonly next: string | null }[];
  readonly expected: number;
}[] = [
  { name: "a single page", pages: [{ ids: ["a"], next: null }], expected: 1 },
  {
    name: "three pages",
    pages: [{ ids: ["a"], next: "?after=1" }, { ids: ["b"], next: "?after=2" }, { ids: ["c"], next: null }],
    expected: 3,
  },
  // A short page carries no information: 500 on a full page, 53 on a tail and 3
  // on a three-row account are the same shape. Only `next` terminates.
  { name: "a short page that is not the last", pages: [{ ids: ["a"], next: "?after=1" }, { ids: ["b", "c"], next: null }], expected: 3 },
  { name: "an account with no transactions", pages: [{ ids: [], next: null }], expected: 0 },
];

for (const { name, pages, expected } of WALK_CASES) {
  test(`the walk terminates only on next === null: ${name}`, async () => {
    const { client } = harness({ responder: pageResponder(pages) });

    assert.equal((await client.getTransactions(CARD_ACCOUNT)).length, expected);
  });
}

test("the walk joins next as a query string, not a path", async () => {
  const responder = pageResponder([{ ids: ["a"], next: "?after=abc" }, { ids: ["b"], next: null }]);
  const { client } = harness({ responder });

  await client.getTransactions(CARD_ACCOUNT);

  // The bug this pins: joining `next` as a path requested something that was
  // not the next page and stopped at 500 rows on an account holding 1053, with
  // no error. Reproduced during the recon that discovered the endpoint.
  assert.equal(responder.urls[1], `${BASE_URL}/v2/transactions?after=abc`);
});

test("the walk fails when the cursor stops advancing", async () => {
  const { client } = harness({ responder: pageResponder([{ ids: ["a"], next: "?after=1" }, { ids: ["b"], next: "?after=1" }]) });

  await assert.rejects(() => client.getTransactions(CARD_ACCOUNT), /cursor/iu);
});

test("the walk fails when a page repeats ids already seen", async () => {
  const { client } = harness({ responder: pageResponder([{ ids: ["a"], next: "?after=1" }, { ids: ["a"], next: "?after=2" }]) });

  await assert.rejects(() => client.getTransactions(CARD_ACCOUNT), /already seen/iu);
});

test("the walk fails loudly on the hop cap instead of looping forever", async () => {
  // The limiter MUST be stubbed. sender() defaults to slidingWindowLimiter with
  // a REAL sleep and the harness uses a fixed clock, so 500 sequential requests
  // stall on a 60s real sleep at request 361 and never return. See client.test.ts:595.
  const { client } = harness({ responder: endlessPageResponder(), limiter: { acquire: async () => {} } });

  await assert.rejects(() => client.getTransactions(CARD_ACCOUNT), /500/u);
});

test("getCategories is fetched once per client and reused", async () => {
  const { client, fetch } = harness({ responder: categoryResponder() });

  await client.getCategories();
  await client.getCategories();

  assert.equal(fetch.calls.filter((call) => call.url.includes("/categories")).length, 1);
});

test("a failed getCategories is not cached", async () => {
  // Caching a rejected promise poisons the process until restart, and the design's
  // error table requires an unreachable /categories to be recoverable content.
  const { client, responder } = harness({ responder: failingThenWorkingCategories() });

  await assert.rejects(() => client.getCategories());
  assert.equal((await client.getCategories()).length, 1);
});
```

**Step 3: Run and watch them fail**

**Step 4: Write the implementation**

Inside `createPluggyClient`, above the returned object:

```ts
/**
 * The ceiling on cursor hops.
 *
 * A bug detector, not a capacity limit. At the observed 500-row page ceiling
 * this is 250,000 rows, past any plausible personal wallet — so reaching it
 * means the cursor is not converging, and "loop until the server says stop" has
 * no natural bound without it.
 */
const MAX_HOPS = 500;

async function walkTransactions(account: Account): Promise<readonly Transaction[]> {
  const transactions: Transaction[] = [];
  const seenIds = new Set<string>();
  let query = `?accountId=${encodeURIComponent(account.id)}`;

  for (let hop = 0; hop < MAX_HOPS; hop += 1) {
    const page = await get(`/v2/transactions${query}`, TRANSACTION_PAGE, `transactions ${account.id}`);

    for (const row of page.results) {
      if (seenIds.has(row.id)) {
        throw new ResponseShapeError(`Transaction ${row.id} was already seen while walking ${account.id}`);
      }
      seenIds.add(row.id);
      transactions.push(toTransaction(row, account));
    }

    if (page.next === null) {
      return transactions;
    }

    // Compared against the query that produced THIS page, not the previous one.
    // An earlier draft kept a `previousQuery` one step behind, which let a
    // repeated cursor through and tripped the duplicate-id guard instead.
    if (page.next === query) {
      throw new ResponseShapeError(`The cursor stopped advancing while walking ${account.id}`);
    }

    query = page.next;
  }

  throw new ResponseShapeError(`Walking ${account.id} exceeded ${MAX_HOPS} pages without reaching the end`);
}

let categories: Promise<readonly TaxonomyEntry[]> | null = null;

function fetchCategories(): Promise<readonly TaxonomyEntry[]> {
  categories ??= get("/categories?pageSize=500&page=1", CATEGORY_PAGE, "categories")
    .then((page) => parseCategoryPage(page))
    .catch((error: unknown) => {
      categories = null;
      throw error;
    });

  return categories;
}
```

Both are declared inside the factory. `client.ts` also grows imports for `ResponseShapeError`, `toTransaction`, `TRANSACTION_PAGE` and `CATEGORY_PAGE`.

**Step 5: Extend the fake**

`tests/fakes/fake-bank.ts` grows `transactions?: Readonly<Record<string, readonly Transaction[]>>` and `categories?: readonly TaxonomyEntry[]`, answering from the fixed list and pushing `` `transactions:${account.id}` `` onto `calls` — the prefix is what Task 9's assertions count. Default `categories` to the seven-entry tree from Task 4 so most callers need not supply one.

**Step 6: Validate and commit**

```bash
npm run typecheck && npm run lint && npm run deps && npm test
git add src/core/contracts.ts src/pluggy/client.ts tests/pluggy/client.test.ts tests/fakes/fake-bank.ts
git commit -m "feat: walk the transaction cursor to its end"
```

---

## Task 8: The store

The most delicate task in the phase. One synchronous write method that never spans an `await`.

**Files:**
- Create: `src/storage/transactions.ts`
- Modify: `src/core/contracts.ts`
- Create: `tests/storage/transactions.test.ts`
- Create: `tests/fakes/transaction-builder.ts` — **one** builder, used by Tasks 8, 9, 10 and 12. Two builders for one domain type in two files is how the fixtures drift apart.

**Step 1: Write the contract**

```ts
/** What a cached transaction range is filtered by. */
export type TransactionFilter = {
  readonly accountIds: readonly string[];
  readonly from: string;
  readonly to: string;
  readonly categories?: readonly string[];
  readonly minAmountCents?: number;
  readonly maxAmountCents?: number;
  readonly accountType?: AccountType;
  readonly accountSubtype?: string;
  /** Page size. Absent means every matching row, which is what an aggregate wants. */
  readonly limit?: number;
  /** Keyset position, exclusive. Ordering is `(local_date DESC, id DESC)`. */
  readonly after?: { readonly localDate: string; readonly id: string };
};

/**
 * The transaction cache core requires of whoever serves it.
 *
 * `replaceAccount` is one method rather than three because the upserts, the
 * convergent delete and the freshness stamp must land in a single SQLite
 * transaction — and because `node:sqlite` is synchronous, that transaction can
 * never span a page fetch. The walk buffers its pages and calls this once.
 *
 * `limit` and `after` live on the filter rather than on a separate paging
 * method so `listTransactions` pages with a real keyset against
 * `transactions_by_date`, instead of loading every matching row and slicing.
 */
export type TransactionStore = {
  /** `undefined` when never walked; `null` when walked against an unknown update time. */
  syncedLastUpdatedAt(accountId: string): string | null | undefined;
  replaceAccount(
    accountId: string,
    connectionId: string,
    rows: readonly Transaction[],
    lastUpdatedAt: string | null,
  ): void;
  query(filter: TransactionFilter): readonly Transaction[];
  byIds(ids: readonly string[]): readonly Transaction[];
  /** The newest `local_date` at or before `today`, per connection. */
  dataThrough(accountIds: readonly string[], today: string): ReadonlyMap<string, string>;
};
```

**Step 2: Write the fixture, explicitly**

The seeded store's contents are what every `QUERY_CASES` expectation depends on. Write them out; do not leave them to the executor.

```ts
/** Seven rows chosen so each filter in QUERY_CASES selects a disjoint, named subset. */
const SEED: readonly Transaction[] = [
  tx({ id: "jun-1",  accountId: "acc-bank", localDate: "2026-06-01", amountCents: -1_000, categoryId: "05020000" }),
  tx({ id: "jun-30", accountId: "acc-bank", localDate: "2026-06-30", amountCents: -2_000, categoryId: "05020000" }),
  tx({ id: "may",    accountId: "acc-bank", localDate: "2026-05-31", amountCents: -3_000, categoryId: "05020000" }),
  tx({ id: "jul",    accountId: "acc-bank", localDate: "2026-07-01", amountCents: -4_000, categoryId: "05020000" }),
  tx({ id: "food",   accountId: "acc-bank", localDate: "2026-05-10", amountCents: -6_000, categoryId: "11000000" }),
  tx({ id: "income", accountId: "acc-bank", localDate: "2026-05-11", amountCents:  9_000, categoryId: "01000000" }),
  tx({ id: "card",   accountId: "acc-card", localDate: "2026-05-12", amountCents: -8_000, categoryId: "09000000",
       accountType: "CREDIT", accountSubtype: "CREDIT_CARD" }),
];

/** Every row, every account, no bounds narrower than the seed. */
const WIDE_FILTER: TransactionFilter = { accountIds: ["acc-bank", "acc-card"], from: "2000-01-01", to: "2100-01-01" };
```

The invariants to preserve when editing `SEED`: only `jun-1` and `jun-30` fall inside June; only `food` carries `11000000`; only `card` is `CREDIT`; `income` is the only positive row; `food` and `card` are the only rows below −5 000 cents.

**Step 3: Write the failing tests**

```ts
describe("replaceAccount", () => {
  it("deletes rows the walk no longer reports", () => {
    const store = storeFor();
    store.replaceAccount("acc-1", "conn-1", [tx({ id: "a" }), tx({ id: "b" })], "2026-07-26T12:00:00.000Z");

    store.replaceAccount("acc-1", "conn-1", [tx({ id: "a" })], "2026-07-27T12:00:00.000Z");

    // A reversed transaction, or a PENDING row that settled under a new id. Upsert
    // alone leaves it forever and every aggregate drifts upward with nothing erroring.
    assert.deepEqual(idsOf(store.query(filterFor(["acc-1"]))), ["a"]);
  });

  it("does not touch another account's rows", () => {
    const store = storeFor();
    store.replaceAccount("acc-1", "conn-1", [tx({ id: "a", accountId: "acc-1" })], null);
    store.replaceAccount("acc-2", "conn-1", [tx({ id: "b", accountId: "acc-2" })], null);

    store.replaceAccount("acc-1", "conn-1", [], null);

    assert.equal(store.query(filterFor(["acc-2"])).length, 1);
  });

  it("is idempotent", () => {
    const store = storeFor();
    const rows = [tx({ id: "a" }), tx({ id: "b" })];

    store.replaceAccount("acc-1", "conn-1", rows, null);
    store.replaceAccount("acc-1", "conn-1", rows, null);

    assert.equal(store.query(filterFor(["acc-1"])).length, 2);
  });

  it("updates a row whose amount changed between walks", () => {
    const store = storeFor();
    store.replaceAccount("acc-1", "conn-1", [tx({ id: "a", amountCents: -1_000 })], null);

    store.replaceAccount("acc-1", "conn-1", [tx({ id: "a", amountCents: -1_500 })], null);

    assert.equal(store.query(filterFor(["acc-1"]))[0]?.amountCents, -1_500);
  });

  it("rolls back and leaves the previous state when a row is rejected", () => {
    const store = storeFor();
    store.replaceAccount("acc-1", "conn-1", [tx({ id: "a" })], null);

    assert.throws(() => store.replaceAccount("acc-1", "conn-1", [tx({ id: "b", localDate: null as never })], null));
    assert.deepEqual(idsOf(store.query(filterFor(["acc-1"]))), ["a"]);
  });

  it("round-trips every field, including the detail columns", () => {
    const store = storeFor();
    const row = tx({ id: "a", mcc: "5814", billId: "bill-1", instalmentNumber: 3, instalmentTotal: 12,
                     document: "12345678900", counterpartyName: "MARIA", paymentMethod: "PIX",
                     originalAmountCents: -2_000, originalCurrency: "USD", purchaseDate: "2026-04-20" });

    store.replaceAccount("acc-1", "conn-1", [row], null);

    assert.deepEqual(store.query(filterFor(["acc-1"]))[0], row);
  });
});

describe("syncedLastUpdatedAt", () => {
  it("is undefined before the first walk", () => {
    assert.equal(storeFor().syncedLastUpdatedAt("acc-1"), undefined);
  });

  const FRESHNESS_CASES: readonly { readonly name: string; readonly stamp: string | null }[] = [
    { name: "a known update time round-trips", stamp: "2026-07-26T12:00:00.000Z" },
    { name: "an unknown update time is stored as null, not absent", stamp: null },
  ];

  for (const { name, stamp } of FRESHNESS_CASES) {
    it(name, () => {
      const store = storeFor();
      store.replaceAccount("acc-1", "conn-1", [], stamp);

      // undefined and null mean different things here: never walked, versus
      // walked against a connection that reports no update time.
      assert.equal(store.syncedLastUpdatedAt("acc-1"), stamp);
    });
  }
});

describe("query", () => {
  const QUERY_CASES: readonly { readonly name: string; readonly filter: Partial<TransactionFilter>; readonly ids: readonly string[] }[] = [
    { name: "bounds the range inclusively at both ends", filter: { from: "2026-06-01", to: "2026-06-30" }, ids: ["jun-30", "jun-1"] },
    { name: "filters by leaf category", filter: { categories: ["11000000"] }, ids: ["food"] },
    { name: "filters by several categories", filter: { categories: ["11000000", "01000000"] }, ids: ["income", "food"] },
    { name: "filters by minimum signed amount", filter: { minAmountCents: -5_000 }, ids: ["income", "jul", "may", "jun-30", "jun-1"] },
    { name: "filters by maximum signed amount", filter: { maxAmountCents: -5_000 }, ids: ["card", "food"] },
    { name: "filters by account type", filter: { accountType: "CREDIT" }, ids: ["card"] },
    { name: "filters by account subtype", filter: { accountSubtype: "CREDIT_CARD" }, ids: ["card"] },
    { name: "filters by account id", filter: { accountIds: ["acc-card"] }, ids: ["card"] },
    { name: "combines filters with AND", filter: { accountType: "CREDIT", categories: ["11000000"] }, ids: [] },
  ];

  for (const { name, filter, ids } of QUERY_CASES) {
    it(name, () => {
      assert.deepEqual(idsOf(seededStore().query({ ...WIDE_FILTER, ...filter })), ids);
    });
  }

  it("orders by date descending and breaks ties on id descending", () => {
    const store = storeFor();
    store.replaceAccount("acc-1", "conn-1", [
      tx({ id: "b", localDate: "2026-06-01" }),
      tx({ id: "a", localDate: "2026-06-01" }),
      tx({ id: "c", localDate: "2026-06-02" }),
    ], null);

    // The tie-break is not cosmetic. Most rows share a localDate, and a keyset
    // cursor over an unstable secondary sort duplicates or skips rows at the
    // page boundary — intermittently, and only on real-sized data.
    assert.deepEqual(idsOf(store.query(filterFor(["acc-1"]))), ["c", "b", "a"]);
  });

  it("pages with a keyset without repeating or skipping a row", () => {
    const store = seededStore();
    const first = store.query({ ...WIDE_FILTER, limit: 3 });
    const last = first.at(-1);
    assert.ok(last);

    const second = store.query({ ...WIDE_FILTER, limit: 3, after: { localDate: last.localDate, id: last.id } });

    assert.equal(new Set([...idsOf(first), ...idsOf(second)]).size, 6);
  });
});

describe("dataThrough", () => {
  it("reports where the data stops, ignoring future instalments", () => {
    const store = storeFor();
    store.replaceAccount("acc-1", "conn-1", [
      tx({ id: "past", localDate: "2026-07-08" }),
      tx({ id: "future", localDate: "2026-10-01" }),
    ], null);

    // The gold card's statement trails its utilization by 18 days. A connection's
    // update time says nothing about where its transactions stop.
    assert.equal(store.dataThrough(["acc-1"], "2026-07-26").get("conn-1"), "2026-07-08");
  });

  it("omits a connection with no cached rows rather than reporting a false date", () => {
    assert.equal(storeFor().dataThrough(["acc-1"], "2026-07-26").size, 0);
  });
});
```

Helpers at the top of the file: `storeFor()` opens `:memory:` with `CACHE_MIGRATIONS` and returns the store, `seededStore()` is `storeFor()` plus `SEED`, `filterFor(ids)` narrows `WIDE_FILTER`, `idsOf(rows)` maps to ids. `tx()` comes from `tests/fakes/transaction-builder.ts`.

**Step 4: Write the implementation**

```ts
export function createTransactionStore(db: DatabaseSync): TransactionStore {
  const insert = db.prepare(`INSERT INTO transactions (...) VALUES (...)
    ON CONFLICT(id) DO UPDATE SET ...`);
  const deleteAbsent = db.prepare(
    `DELETE FROM transactions WHERE account_id = ? AND id NOT IN (SELECT value FROM json_each(?))`,
  );
  const stamp = db.prepare(`INSERT INTO transaction_sync (account_id, connection_id, last_updated_at)
    VALUES (?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET
      connection_id = excluded.connection_id, last_updated_at = excluded.last_updated_at`);

  return {
    replaceAccount(accountId, connectionId, rows, lastUpdatedAt) {
      // One transaction, entirely synchronous. `node:sqlite` is connection-scoped
      // and a BEGIN held across an await swallows the next walk's BEGIN with
      // SQLITE_ERROR: cannot start a transaction within a transaction. The walk
      // buffers its pages precisely so this method never has to wait for one.
      db.exec("BEGIN");
      try {
        for (const row of rows) {
          insert.run(...);
        }
        deleteAbsent.run(accountId, JSON.stringify(rows.map((row) => row.id)));
        stamp.run(accountId, connectionId, lastUpdatedAt);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    ...
  };
}
```

`json_each` over a JSON array is how a variable-length `NOT IN` stays one prepared statement; `node:sqlite` ships SQLite with JSON1 built in. `query` builds its `WHERE` from the present filter fields and appends `ORDER BY local_date DESC, id DESC` plus, when `after` is set, `AND (local_date, id) < (?, ?)`.

**Step 5: Validate and commit**

```bash
npm run typecheck && npm run lint && npm run deps && npm test
git add src/storage/transactions.ts src/core/contracts.ts tests/storage/transactions.test.ts tests/fakes/transaction-builder.ts
git commit -m "feat: cache transactions with a convergent write"
```

---

## Task 9: The aggregate

**Files:**
- Create: `src/core/aggregate.ts`
- Create: `tests/core/aggregate.test.ts`

**Step 1: Define the result type first**

The tests below reference every field, so it is not optional detail. Note that `label` is **not** here: it comes from `core/category.ts` in the MCP layer, because the recon found Pluggy's own `descriptionTranslated` carries broken strings like `Transferências- DOC`.

```ts
export type CategoryGroup = {
  /** `null` for rows Pluggy did not categorize at all. */
  readonly categoryId: CategoryId | null;
  /** Signed, so a refund nets against a purchase in the same group. */
  readonly totalCents: number;
  readonly count: number;
  /** At most ten, largest by absolute amount (ADR §14.2). */
  readonly sampleIds: readonly string[];
};

export type Aggregate = {
  readonly groups: readonly CategoryGroup[];
  /** A positive magnitude. Excludes self-transfers and future rows. */
  readonly spentCents: number;
  readonly receivedCents: number;
  readonly upcoming: { readonly totalCents: number; readonly count: number };
};
```

**Step 2: Write the fixture, explicitly**

```ts
/** Every id the test file uses, and deliberately not 88888888. */
const ROLLUP: ReadonlyMap<string, CategoryId> = buildRollup([
  { id: "01000000", parentId: null },   // Income
  { id: "04000000", parentId: null },   // Same person transfer
  { id: "05000000", parentId: null },   // Transfers
  { id: "05020000", parentId: "05000000" },  // Transfers - PIX
  { id: "05100000", parentId: "05000000" },  // Credit card payment
  { id: "09000000", parentId: null },   // Digital services
  { id: "11000000", parentId: null },   // Food and drinks
  { id: "20000000", parentId: null },   // Insurance
  { id: "200100000", parentId: "20000000" },  // Life insurance
  { id: "99999999", parentId: null },   // Other
]);

const TODAY = "2026-06-30";
```

`99999999` is a real entry in `CATEGORIES`, so "uncategorized groups separately from Other" needs it present, not absent.

**Step 3: Write the failing tests**

```ts
it("rolls children up into their top-level parent", () => {
  const result = aggregate([tx({ categoryId: "200100000", amountCents: -5_000 })], ROLLUP, TODAY);

  assert.deepEqual(result.groups.map((group) => group.categoryId), ["20000000"]);
});

it("does not count paying the card bill as spending or income", () => {
  // With the sign flip, a bill payment is negative on the checking account and
  // positive on the card. Counted, "quanto gastei" reports the month's purchases
  // plus the payment that settles them, and calls the payment income.
  const result = aggregate([
    tx({ id: "purchase", accountType: "CREDIT", categoryId: "11000000", amountCents: -10_000 }),
    tx({ id: "payment-out", accountType: "BANK", categoryId: "05100000", amountCents: -10_000 }),
    tx({ id: "payment-in", accountType: "CREDIT", categoryId: "05100000", amountCents: 10_000 }),
  ], ROLLUP, TODAY);

  assert.equal(result.spentCents, 10_000);
  assert.equal(result.receivedCents, 0);
});

it("does not count a transfer between your own accounts as spending", () => {
  assert.equal(aggregate([tx({ categoryId: "04000000", amountCents: -50_000 })], ROLLUP, TODAY).spentCents, 0);
});

it("still lists an excluded transfer as a group", () => {
  // Excluded from the headline figures, not hidden. "Where did my money move"
  // is a real question and the group is the answer to it.
  const result = aggregate([tx({ categoryId: "05100000", amountCents: -10_000 })], ROLLUP, TODAY);

  assert.deepEqual(result.groups.map((group) => group.categoryId), ["05000000"]);
});

it("counts a payment to another person as spending", () => {
  // The exclusion runs on the leaf id. Excluding the whole Transfers group would
  // drop this, which is a genuine outgoing payment.
  assert.equal(aggregate([tx({ categoryId: "05020000", amountCents: -30_000 })], ROLLUP, TODAY).spentCents, 30_000);
});

const FUTURE_CASES: readonly { readonly name: string; readonly localDate: string; readonly spent: number; readonly upcoming: number }[] = [
  { name: "yesterday counts as spent", localDate: "2026-06-29", spent: 20_000, upcoming: 0 },
  { name: "today counts as spent", localDate: "2026-06-30", spent: 20_000, upcoming: 0 },
  { name: "tomorrow counts as upcoming", localDate: "2026-07-01", spent: 0, upcoming: 1 },
  { name: "a far future instalment counts as upcoming", localDate: "2026-10-01", spent: 0, upcoming: 1 },
];

for (const { name, localDate, spent, upcoming } of FUTURE_CASES) {
  it(`splits future rows at today, inclusive: ${name}`, () => {
    const result = aggregate([tx({ localDate, amountCents: -20_000 })], ROLLUP, TODAY);

    assert.equal(result.spentCents, spent);
    assert.equal(result.upcoming.count, upcoming);
  });
}

it("reports spent and received as magnitudes, not signed", () => {
  const result = aggregate([
    tx({ id: "out", amountCents: -10_000 }),
    tx({ id: "in", categoryId: "01000000", amountCents: 30_000 }),
  ], ROLLUP, TODAY);

  // "spent: -4820.15" renders as "you spent minus R$4,820". The names carry the
  // direction; group totals stay signed so refunds net correctly.
  assert.equal(result.spentCents, 10_000);
  assert.equal(result.receivedCents, 30_000);
});

it("keeps a group total signed so a refund nets against a purchase", () => {
  const result = aggregate([
    tx({ id: "buy", amountCents: -10_000 }),
    tx({ id: "refund", amountCents: 4_000 }),
  ], ROLLUP, TODAY);

  assert.equal(result.groups[0]?.totalCents, -6_000);
});

it("takes the ten largest ids by absolute amount as the sample", () => {
  const rows = Array.from({ length: 15 }, (_, index) => tx({ id: `t-${index}`, amountCents: -(index + 1) * 100 }));

  const group = aggregate(rows, ROLLUP, TODAY).groups[0];

  assert.equal(group?.sampleIds.length, 10);
  assert.equal(group?.sampleIds[0], "t-14");
});

it("groups an uncategorized row separately from Other", () => {
  const result = aggregate([
    tx({ id: "none", categoryId: null, amountCents: -100 }),
    tx({ id: "other", categoryId: "99999999", amountCents: -200 }),
  ], ROLLUP, TODAY);

  assert.equal(result.groups.length, 2);
  assert.ok(result.groups.some((group) => group.categoryId === null));
});

it("reports a category absent from the tree rather than dropping it", () => {
  assert.throws(() => aggregate([tx({ categoryId: "88888888" })], ROLLUP, TODAY), /88888888/u);
});

it("returns zeroes rather than failing on an empty set", () => {
  const result = aggregate([], ROLLUP, TODAY);

  assert.deepEqual(result.groups, []);
  assert.equal(result.spentCents, 0);
});

it("orders groups by absolute total, largest first", () => {
  const result = aggregate([
    tx({ id: "small", categoryId: "11000000", amountCents: -100 }),
    tx({ id: "big", categoryId: "09000000", amountCents: -900 }),
  ], ROLLUP, TODAY);

  assert.deepEqual(result.groups.map((group) => group.categoryId), ["09000000", "11000000"]);
});
```

**Step 4: Implement**

The exclusion set is the load-bearing constant:

```ts
/**
 * Leaf categories that move money between your own accounts.
 *
 * Excluded from `spent` and `received`, never from the groups. Matching is on
 * the **leaf** id, not the rolled-up group: `05100000` rolls up into
 * `05000000 Transfers`, and excluding the whole group would also drop genuine
 * outgoing payments to other people.
 */
const SELF_TRANSFER_LEAVES: ReadonlySet<string> = new Set([
  "04000000", "04010000", "04020000", "04030000",  // Same person transfer, and its children
  "05100000",                                       // Credit card payment
]);
```

**Step 5: Validate and commit**

```bash
npm run typecheck && npm run lint && npm run deps && npm test
git add src/core/aggregate.ts tests/core/aggregate.test.ts
git commit -m "feat: aggregate transactions by rolled-up category"
```

---

## Task 10: The reader — orchestration and single-flight

**Files:**
- Create: `src/core/transactions.ts`
- Create: `tests/core/transactions.test.ts`

Model it on `src/core/accounts.ts`, which already fans out across connections and collects partial failures. Reuse `collectAccounts` rather than re-implementing the fan-out.

**Freshness comes off the `Account`, not from a second fetch.** `toAccount` stamps `connection.lastUpdatedAt` onto every account (`mapper.ts:124`), and `client.getAccounts` already fetches the item to obtain it. A `getConnection` call inside the reader would be a second request for a value already in hand — three wasted round trips per warm tool call on this wallet.

**Step 1: Define the shape**

```ts
export type TransactionReader = {
  /**
   * Every account on the given connections, with its transactions cached and
   * current. Walks only the accounts whose connection reports a `lastUpdatedAt`
   * different from the one recorded at their last walk.
   */
  load(connectionIds: readonly string[]): Promise<LoadResult>;
};

export type LoadResult = {
  readonly accounts: readonly Account[];
  readonly unavailable: readonly UnavailableConnection[];
};
```

**Step 2: Write the failing tests**

`readerFor(options)` builds a `fakeBank`, an in-memory store and a `fixedClock`, and returns `{ reader, bank, store, setLastUpdatedAt }`. `setLastUpdatedAt` mutates the fake's connection — deliberately *not* named `advance`, because `fixedClock.advance` already exists and means something else.

```ts
it("walks and stores on a cold cache", async () => {
  const { reader, store } = readerFor({ transactions: { "acc-1": [tx({ id: "a" })] } });

  await reader.load(["conn-1"]);

  assert.equal(store.query(WIDE_FILTER).length, 1);
});

it("does not re-walk when the update time is unchanged", async () => {
  const { reader, bank } = readerFor({ lastUpdatedAt: "2026-07-26T12:00:00.000Z" });
  await reader.load(["conn-1"]);

  await reader.load(["conn-1"]);

  assert.equal(walkCount(bank), 1);
});

it("re-walks in full when the update time is newer", async () => {
  const { reader, bank, setLastUpdatedAt } = readerFor({ lastUpdatedAt: "2026-07-26T12:00:00.000Z" });
  await reader.load(["conn-1"]);

  setLastUpdatedAt("conn-1", "2026-07-27T12:00:00.000Z");
  await reader.load(["conn-1"]);

  assert.equal(walkCount(bank), 2);
});

it("always re-walks when the update time is unknown", async () => {
  const { reader, bank } = readerFor({ lastUpdatedAt: null });
  await reader.load(["conn-1"]);
  await reader.load(["conn-1"]);

  // null means freshness is unknown, and an unknown must not read as unchanged.
  assert.equal(walkCount(bank), 2);
});

it("does not fetch the connection separately from its accounts", async () => {
  const { reader, bank } = readerFor({ lastUpdatedAt: "2026-07-26T12:00:00.000Z" });
  await reader.load(["conn-1"]);
  const warm = bank.calls.length;

  await reader.load(["conn-1"]);

  // toAccount already stamps lastUpdatedAt onto every Account, and getAccounts
  // already fetched the item to get it. A second item request per connection is
  // three wasted round trips per warm call on this wallet.
  assert.equal(bank.calls.length - warm, 1);
});

it("walks an account once when two loads arrive together", async () => {
  const { reader, bank } = readerFor({ lastUpdatedAt: "2026-07-26T12:00:00.000Z" });

  const [first, second] = await Promise.all([reader.load(["conn-1"]), reader.load(["conn-1"])]);

  assert.equal(walkCount(bank), 1);
  assert.deepEqual(first, second);
});

it("does not leave a failed walk in flight", async () => {
  const { reader, bank, recover } = readerFor({ walkFails: true });
  await assert.rejects(() => reader.load(["conn-1"]));

  recover();
  await reader.load(["conn-1"]);

  // Deleting in a finally, not a then: a rejected walk must not poison the
  // account until the process restarts.
  assert.equal(walkCount(bank), 2);
});

it("does not stamp freshness when the walk fails", async () => {
  const { reader, store } = readerFor({ walkFails: true });

  await assert.rejects(() => reader.load(["conn-1"]));

  // A stamp written before the rows land records a completeness the cache does
  // not have, and the next call serves a truncated history as fresh.
  assert.equal(store.syncedLastUpdatedAt("acc-1"), undefined);
});

it("reports an unavailable connection rather than throwing", async () => {
  const { reader } = readerFor({ unreachable: { "conn-2": new AuthError("revoked", 401) } });

  const result = await reader.load(["conn-1", "conn-2"]);

  assert.equal(result.unavailable.length, 1);
  assert.equal(result.unavailable[0]?.connectionId, "conn-2");
});

it("walks the accounts of a healthy connection when another is unavailable", async () => {
  const { reader, store } = readerFor({ unreachable: { "conn-2": new AuthError("revoked", 401) } });

  await reader.load(["conn-1", "conn-2"]);

  assert.ok(store.query(WIDE_FILTER).length > 0);
});
```

**Step 3–4: Red, implement, green**

```ts
const inFlight = new Map<string, Promise<void>>();

function walkOnce(account: Account): Promise<void> {
  const existing = inFlight.get(account.id);
  if (existing !== undefined) {
    return existing;
  }

  const walk = performWalk(account).finally(() => inFlight.delete(account.id));
  inFlight.set(account.id, walk);

  return walk;
}

async function performWalk(account: Account): Promise<void> {
  const rows = await bank.getTransactions(account);
  const lastUpdatedAt = account.lastUpdatedAt?.toISOString() ?? null;

  // One synchronous call, after every page is in hand. The store's contract
  // exists in this shape so no SQLite transaction ever spans the await above.
  store.replaceAccount(account.id, account.connectionId, rows, lastUpdatedAt);
  log.info({ accountId: account.id, connectionId: account.connectionId, rows: rows.length }, "Walked transactions");
}
```

The `deleted` count belongs on that log line — `replaceAccount` returns it, and a nonzero value is the first real evidence on the open id-stability question.

**Step 5: Commit**

```bash
git add src/core/transactions.ts tests/core/transactions.test.ts
git commit -m "feat: orchestrate transaction loading with a per-account single-flight"
```

---

## Task 11: Wiring, verified by hand

**Files:**
- Modify: `src/mcp/source.ts`
- Modify: `src/bin/cata-centavo.ts`
- Modify: `tests/fakes/fake-source.ts`

**There is no unit test here, and that is deliberate.** `Source` is built by a private `toSource()` inside `bin/cata-centavo.ts`, a top-level-await script that reads `process.argv` and dispatches at module scope — importing it from a test runs the CLI. And `src/mcp/source.ts` cannot import `SchemaTooNewError` from `src/storage/db.ts`, because `.dependency-cruiser.js`'s `only-bin-builds-infrastructure` forbids `^src/mcp/ → ^src/storage/` at error severity. Phase 1's Task 14 hit exactly this and answered it with a `printf | node` handshake. Do the same.

**Step 1: Grow `Source`**

`ok: true` gains `reader: TransactionReader` — **the reader, not the store**. The store is an implementation detail of the reader and `mcp/` has no business holding one. `ok: false` gains the database problems, with `SchemaTooNewError` reading as its own failure class: the user's cache was written by a newer build, and the fix is different from a missing credential.

**Step 2: Update `tests/fakes/fake-source.ts` in the same commit**

`FakeSource = Extract<Source, { readonly ok: true }>`, so the moment `Source` grows a field, `fakeSource()`'s return literal fails typecheck — and with it every existing MCP tool test. Add `reader`, defaulting to a reader over a `:memory:` store and the fake bank.

**Step 3: Open the database in `bin/`**

`openDatabases(paths)`, `createTransactionStore(databases.cache)`, `createTransactionReader({...})`, and close the handles on shutdown alongside the existing teardown.

**Step 4: Verify by hand**

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}' \
  | node src/bin/cata-centavo.ts
```

Expected: one JSON-RPC line on stdout and nothing else. Any banner, log line or SQLite warning on stdout is a bug — in server mode stdout *is* the protocol channel.

Then confirm the cache file appears under `XDG_CACHE_HOME` and that a second run does not recreate it.

**Step 5: Commit**

```bash
git add src/mcp/source.ts src/bin/cata-centavo.ts tests/fakes/fake-source.ts
git commit -m "feat: open the cache database in server mode"
```

---

## Task 12: Shared tool boilerplate

Small, and it comes before the tools because all three need it and because `max-lines` warns at 250.

**Files:**
- Create: `src/mcp/tools/result.ts`
- Modify: `src/mcp/tools/accounts.ts`, `src/mcp/tools/balance.ts`

`textResult`, `finishToolError` and `ToolDeps` are currently **copied** into both existing tool files. A third copy would settle the duplication as house style. Move them to `result.ts` and have both existing files import them; the existing tests must stay green unchanged, which is the check that the move is behaviour-preserving.

`ToolDeps` grows `reader: TransactionReader` and `clock: Clock`.

```bash
npm run typecheck && npm run lint && npm run deps && npm test
git add src/mcp/tools/result.ts src/mcp/tools/accounts.ts src/mcp/tools/balance.ts
git commit -m "refactor: share the tool result helpers"
```

---

## Task 13: `getTransactions`

**Files:**
- Create: `src/mcp/tools/transactions.ts`
- Create: `tests/mcp/tools/transactions.test.ts`

**Step 1: Write the description**

Every tool description follows the three-part template, because descriptions are the only discovery surface a model gets.

```ts
export const GET_TRANSACTIONS_DESCRIPTION = `Totals spending and income over a date range, grouped by category.

Use this tool when:
- You need to know how much was spent in a period, overall or in one category.
- You need to compare categories or periods against each other.
- You need transaction ids to look at individual rows afterwards.

Returns: \`spent\` and \`received\` as positive amounts, and one group per category with a signed total, a count and up to ten sample ids. Transfers between the user's own accounts and credit card bill payments are listed as groups but excluded from \`spent\` and \`received\`, because moving money between your own accounts is not spending. Instalments dated in the future are reported separately as \`upcoming\`. \`dataThrough\` states the most recent date each connection has actually supplied, which can trail its last sync by weeks.`;
```

**Step 2: Validation uses `safeParse`, and this is a deviation to write down**

`handleGetBalanceByAccount` calls `.parse` at the top, so a bad argument throws a `ZodError` and becomes a protocol error. That is fine for a single account id. It is wrong here: the design's error table commits to `isError` content naming the cap, and a thrown `ZodError` lands in the channel the model cannot see. Use `safeParse` and convert a failure into readable content.

**Step 3: Write the failing tests**

The parameter-reachability test is a **table test** over the declared parameters. PRD bar #3 exists because the prior Go implementation shipped a filter that was parsed, validated and never read.

```ts
const RANGE = { startDate: "2026-06-01", endDate: "2026-06-30" };

const PARAMETER_CASES: readonly {
  readonly name: string;
  readonly input: Record<string, unknown>;
  readonly expected: Partial<TransactionFilter>;
}[] = [
  { name: "startDate", input: RANGE, expected: { from: "2026-06-01" } },
  { name: "endDate", input: RANGE, expected: { to: "2026-06-30" } },
  { name: "categories", input: { ...RANGE, categories: ["11000000"] }, expected: { categories: ["11000000"] } },
  { name: "minAmountCents", input: { ...RANGE, minAmountCents: -5_000 }, expected: { minAmountCents: -5_000 } },
  { name: "maxAmountCents", input: { ...RANGE, maxAmountCents: -100 }, expected: { maxAmountCents: -100 } },
  { name: "accountType", input: { ...RANGE, accountType: "CREDIT" }, expected: { accountType: "CREDIT" } },
  { name: "accountSubtype", input: { ...RANGE, accountSubtype: "CREDIT_CARD" }, expected: { accountSubtype: "CREDIT_CARD" } },
];

for (const { name, input, expected } of PARAMETER_CASES) {
  it(`passes ${name} through to the query`, async () => {
    const deps = depsWith(recordingStore());
    await handleGetTransactions(deps, input);

    const filter = lastFilterOf(deps);
    assert.ok(filter);
    for (const [key, value] of Object.entries(expected)) {
      assert.deepEqual(filter[key as keyof TransactionFilter], value, key);
    }
  });
}

it("rejects an invented category at the boundary", async () => {
  const result = await handleGetTransactions(depsWith(), { ...RANGE, categories: ["alimentacao"] });

  // Free-form strings let an agent invent `alimentacao` and `alimentação` in one
  // database and break every aggregate (ADR §12.4).
  assert.equal(result.isError, true);
});

it("rejects an end date before the start date", async () => {
  const result = await handleGetTransactions(depsWith(), { startDate: "2026-06-30", endDate: "2026-06-01" });

  assert.equal(result.isError, true);
});

const REFUSAL_CASES: readonly { readonly name: string; readonly deps: () => ToolDeps; readonly matches: RegExp }[] = [
  { name: "an unavailable connection", deps: withUnavailable, matches: /conn-2/u },
  { name: "mixed account currencies", deps: withMixedCurrencies, matches: /USD/u },
  { name: "an unreachable category tree", deps: withCategoriesDown, matches: /categor/iu },
];

for (const { name, deps, matches } of REFUSAL_CASES) {
  it(`refuses rather than returning a partial total: ${name}`, async () => {
    const result = await handleGetTransactions(deps(), RANGE);

    assert.equal(result.isError, true);
    assert.match(textOf(result), matches);
    assert.doesNotMatch(textOf(result), /"spent"/u);
  });
}

it("reads an empty period as empty rather than as a failure", async () => {
  const result = await handleGetTransactions(depsWith(emptyStore()), RANGE);

  assert.notEqual(result.isError, true);
  assert.equal(JSON.parse(textOf(result)).spent, "0.00");
});

it("keeps a zero total through serialization", () => {
  // prune() strips null and undefined only. A balance of exactly 0 disappearing
  // is a financial bug.
  assert.match(textOf(zeroSpendResult()), /"spent":"0\.00"/u);
});

it("does not trip the currency guard on a foreign purchase", async () => {
  const result = await handleGetTransactions(depsWith(storeWithForeignPurchase()), RANGE);

  assert.notEqual(result.isError, true);
});

it("labels groups from our own category list, not the fetched strings", async () => {
  const result = await handleGetTransactions(depsWith(seededStore()), RANGE);

  // Pluggy's descriptionTranslated carries "Transferências- DOC" with a missing
  // space; the recon warns the Portuguese strings are not clean display text.
  assert.equal(JSON.parse(textOf(result)).groups[0].label, CATEGORIES.transfers.pt);
});

it("derives today from the injected clock, in São Paulo", async () => {
  const deps = depsWith(storeWithRow({ localDate: "2026-06-30" }), fixedClock(new Date("2026-07-01T01:00:00.000Z")));

  const result = await handleGetTransactions(deps, RANGE);

  // 22:00 on 30 June locally. A UTC-derived "today" moves the evening's
  // purchases into `upcoming` and reports nothing spent.
  assert.equal(JSON.parse(textOf(result)).upcoming, undefined);
});
```

`depsWith(store?, clock?)` is the one arrange helper; `withUnavailable`, `withMixedCurrencies` and `withCategoriesDown` are thin wrappers over it. Define them once at the top of the file.

**Step 4: Implement, then run**

**Step 5: Commit**

```bash
git add src/mcp/tools/transactions.ts tests/mcp/tools/transactions.test.ts
git commit -m "feat: add the getTransactions tool"
```

---

## Task 14: The cursor

Its own task, because it has real encoding decisions and Task 15 depends on all of them.

**Files:**
- Create: `src/mcp/cursor.ts`
- Create: `tests/mcp/cursor.test.ts`

**Step 1: Fix the shape**

A cursor is base64url of `{"d":"<localDate>","i":"<id>","f":"<fingerprint>"}`. The fingerprint is a SHA-256 (via `node:crypto`) of the JSON of the filter with `limit`, `after` and key order removed — everything that legitimately varies between pages of one query, and nothing else.

**Step 2: Write the failing tests**

```ts
it("round-trips a position", () => {
  const position = { localDate: "2026-06-15", id: "t-1" };

  assert.deepEqual(decodeCursor(encodeCursor(position, FILTER), FILTER).position, position);
});

it("rejects a cursor issued for different filters", () => {
  const cursor = encodeCursor({ localDate: "2026-06-15", id: "t-1" }, FILTER);

  // A keyset applied to a different filter is meaningless, and the page it
  // produces is silently wrong rather than empty.
  assert.equal(decodeCursor(cursor, { ...FILTER, categories: ["11000000"] }).ok, false);
});

it("accepts a cursor when only the page size changed", () => {
  const cursor = encodeCursor({ localDate: "2026-06-15", id: "t-1" }, { ...FILTER, limit: 10 });

  assert.equal(decodeCursor(cursor, { ...FILTER, limit: 50 }).ok, true);
});

it("is insensitive to key order in the filter", () => {
  const cursor = encodeCursor({ localDate: "2026-06-15", id: "t-1" }, { from: "a", to: "b", accountIds: [] });

  assert.equal(decodeCursor(cursor, { to: "b", accountIds: [], from: "a" }).ok, true);
});

const MALFORMED: readonly { readonly name: string; readonly cursor: string }[] = [
  { name: "empty", cursor: "" },
  { name: "not base64", cursor: "!!!" },
  { name: "base64 of not-JSON", cursor: Buffer.from("hello").toString("base64url") },
  { name: "JSON missing the position", cursor: Buffer.from('{"f":"x"}').toString("base64url") },
];

for (const { name, cursor } of MALFORMED) {
  it(`refuses a malformed cursor rather than throwing: ${name}`, () => {
    assert.equal(decodeCursor(cursor, FILTER).ok, false);
  });
}
```

A malformed cursor returns `ok: false`, never throws — it arrives as model input, and an exception there is a protocol error for something the model should be told to fix.

**Steps 3–5: Red, implement, green, commit**

---

## Task 15: `listTransactions`

**Files:**
- Modify: `src/mcp/tools/transactions.ts`
- Test: `tests/mcp/tools/transactions.test.ts` (**extend**)

**Step 1: Write the failing tests**

```ts
const CAP_CASES: readonly { readonly name: string; readonly limit: unknown; readonly ok: boolean }[] = [
  { name: "one row", limit: 1, ok: true },
  { name: "the cap itself", limit: 100, ok: true },
  { name: "one over the cap", limit: 101, ok: false },
  { name: "wildly over the cap", limit: 500, ok: false },
  { name: "zero", limit: 0, ok: false },
  { name: "negative", limit: -1, ok: false },
  { name: "fractional", limit: 1.5, ok: false },
];

for (const { name, limit, ok } of CAP_CASES) {
  it(`enforces the row limit: ${name}`, async () => {
    const result = await handleListTransactions(depsWith(seededStore()), { ...RANGE, limit });

    // Refused, not clamped. Silently returning 100 rows to a caller who asked
    // for 500 hands back a page they believe is complete.
    assert.equal(result.isError !== true, ok);
  });
}

it("pages forward without repeating or skipping a row", async () => {
  const deps = depsWith(storeWith(150));
  const first = await handleListTransactions(deps, { ...RANGE, limit: 100 });
  const { cursor } = JSON.parse(textOf(first));

  const second = await handleListTransactions(deps, { ...RANGE, limit: 100, cursor });

  assert.equal(new Set([...idsOf(first), ...idsOf(second)]).size, 150);
});

it("offers no cursor on the last page", async () => {
  const result = await handleListTransactions(depsWith(storeWith(10)), { ...RANGE, limit: 100 });

  assert.equal(JSON.parse(textOf(result)).cursor, undefined);
});

it("refuses a cursor issued for different filters", async () => {
  const deps = depsWith(storeWith(150));
  const first = await handleListTransactions(deps, { ...RANGE, limit: 100 });
  const { cursor } = JSON.parse(textOf(first));

  const result = await handleListTransactions(deps, {
    startDate: "2026-01-01", endDate: "2026-12-31", limit: 100, cursor,
  });

  assert.equal(result.isError, true);
});

it("degrades with a notice instead of refusing when a connection is unavailable", async () => {
  const result = await handleListTransactions(withUnavailable(), { ...RANGE, limit: 10 });

  // Aggregates refuse a partial total; listings degrade and say what is missing.
  assert.notEqual(result.isError, true);
  assert.match(textOf(result), /conn-2/u);
});

it("returns money as a decimal string", async () => {
  const result = await handleListTransactions(depsWith(storeWithRow({ amountCents: -8_990 })), { ...RANGE, limit: 10 });

  assert.equal(JSON.parse(textOf(result)).transactions[0].amount, "-89.90");
});
```

One `deps` per test, reused across both calls — two `storeWith(150)` instances relying on byte-identical rows is a trap.

**Steps 2–5: Red, implement, green, commit**

---

## Task 16: `getTransactionDetails`

**Files:**
- Create: `src/mcp/tools/transaction-details.ts`
- Create: `tests/mcp/tools/transaction-details.test.ts`

Its own file because `max-lines` warns at 250 and Tasks 13 and 15 have already filled `transactions.ts`.

**Step 1: Write the failing tests**

```ts
it("returns our field names, not Pluggy's", async () => {
  const result = await handleGetTransactionDetails(depsWith(seededStore()), { ids: ["t-card-1"] });
  const [detail] = JSON.parse(textOf(result)).transactions;

  // ADR §14.0: our tools return our shape. Handing back paymentData and
  // creditCardMetadata re-exposes Pluggy's vocabulary and its floats.
  assert.equal(detail.paymentData, undefined);
  assert.equal(detail.creditCardMetadata, undefined);
  assert.equal(detail.instalment.number, 3);
  assert.equal(detail.instalment.total, 12);
});

it("returns money as a decimal string", async () => {
  const result = await handleGetTransactionDetails(depsWith(seededStore()), { ids: ["t-card-1"] });

  assert.equal(JSON.parse(textOf(result)).transactions[0].amount, "-89.90");
});

it("omits the instalment block entirely when there is none", async () => {
  const result = await handleGetTransactionDetails(depsWith(seededStore()), { ids: ["t-bank-1"] });

  assert.equal(JSON.parse(textOf(result)).transactions[0].instalment, undefined);
});

it("reports the original amount on a foreign purchase", async () => {
  const result = await handleGetTransactionDetails(depsWith(seededStore()), { ids: ["t-card-foreign"] });
  const [detail] = JSON.parse(textOf(result)).transactions;

  assert.equal(detail.original.amount, "-20.00");
  assert.equal(detail.original.currency, "USD");
});

it("names an unknown id rather than dropping it", async () => {
  const result = await handleGetTransactionDetails(depsWith(seededStore()), { ids: ["t-card-1", "nope"] });

  assert.equal(result.isError, true);
  assert.match(textOf(result), /nope/u);
});

const ID_COUNT_CASES: readonly { readonly name: string; readonly count: number; readonly ok: boolean }[] = [
  { name: "one id", count: 1, ok: true },
  { name: "the cap itself", count: 20, ok: true },
  { name: "one over the cap", count: 21, ok: false },
  { name: "none", count: 0, ok: false },
];

for (const { name, count, ok } of ID_COUNT_CASES) {
  it(`enforces the id count: ${name}`, async () => {
    const ids = Array.from({ length: count }, (_, index) => `t-${index}`);

    assert.equal((await handleGetTransactionDetails(depsWith(storeWithIds(ids)), { ids })).isError !== true, ok);
  });
}

it("refuses duplicate ids rather than returning a row twice", async () => {
  const result = await handleGetTransactionDetails(depsWith(seededStore()), { ids: ["t-card-1", "t-card-1"] });

  assert.equal(result.isError, true);
});
```

**Steps 2–5: Red, implement, green, commit**

---

## Task 17: Registration

**Files:**
- Modify: `src/mcp/server.ts`
- Test: `tests/mcp/server.test.ts` (**extend the existing registration test's expected list — do not add a second one**)

```bash
npm run typecheck && npm run lint && npm run deps && npm test
git add src/mcp/server.ts tests/mcp/server.test.ts
git commit -m "feat: register the transaction tools"
```

---

## Task 18: The live acceptance run

**This task is verification, not TDD.** Run against real connections and check the numbers by hand.

**Do not use `npm run dev`.** npm prints to stdout, which is the one channel this run is checking.

```bash
nvm use && node src/bin/cata-centavo.ts
```

Then, in a Claude Code session with the server attached:

1. "Quanto gastei em junho?" — check the total against the banking app for one account.
2. Ask again immediately. Confirm from the stderr log that no walk happened the second time.
3. "Quanto gastei com mercado em junho?" — confirm the category filter changes the number.
4. Ask for the rows behind one group, then for details on two of them.
5. Ask for 500 rows and confirm the refusal is readable content, not a protocol error.
6. Confirm that a card bill payment in the period does not inflate the total.

**Record the `deleted` count from every walk log line.** A nonzero count is the first real evidence on the open question of whether transaction ids survive a re-sync, and it belongs in `docs/research/`.

---

## Task 19: Amendments

**Files:**
- Modify: `docs/adr/0001-stack-and-architecture.md` — §14.2 (tool signatures, `minAmountCents`, transfer exclusions), §14.7 (inventory), §12.12 (point 3 closed)
- Modify: `docs/prd.md` — close open decisions #4 and #6, mark Phase 2 done
- Create: `docs/research/2026-07-26-phase-2-acceptance.md` — Task 18's numbers

CLAUDE.md calls a change to one of the pair that does not reach the other a bug in the pair. Run the prose through the `humanizer` skill.

---

## Task 20: Mutation testing

**Files:**
- Modify: `stryker.config.json`

Add `src/storage/transactions.ts` to `mutate`. The freshness comparison and the convergent delete are exactly the green-but-assertionless case mutation testing exists to catch, and they currently sit outside the configured scope.

```bash
npm run mutation      # ~50s, plus the new files
```

Read the survivors. For each, either write the missing assertion or suppress with a reason (`// Stryker disable next-line <Mutator>: why`). It never fails the build.

Pay attention to survivors in `core/aggregate.ts` around the exclusion set and the future-date boundary, in `pluggy/mapper.ts` around the sign flip, and in `pluggy/client.ts` around the cursor guards. A surviving mutant on the sign flip means no test would notice if every card transaction changed direction.

---

## What this phase deliberately does not do

`setCategory`, `setCounterpartyCategory`, the MCC map, the `COALESCE` derivation chain, rules, bills and instalments — all Phase 3 and 4.

**`status` is parsed and dropped.** The recon found 74 `PENDING` rows, whose amounts typically change on settlement, and Phase 2 counts them with nothing marking them provisional. `PENDING` matters to the open bill, which is Phase 4's subject and has its own probe document.

**Phase 2's grouping runs in memory over rows loaded from SQL, and that is temporary.** ADR §12.2 argues the category filter belongs in SQL and §12.3 makes derivation-inside-one-query load-bearing; at 1751 rows the in-memory shape is not a performance problem, and building the seed table now would pull Phase 3's scope forward. What Phase 2 does instead is leave the door open: `document` and `mcc` are real columns, and the leaf `category_id` is stored unrolled, so Phase 3 is an addition rather than a rewrite.

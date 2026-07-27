# Phase 3 — categories Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Harvest Pluggy's enrichment into `data.db` while it still exists, and serve every read from a six-branch derivation that keeps returning the same numbers after the enrichment stops.

**Architecture:** The 130-entry category tree stops coming from the network and ships as a code constant, so the roll-up to the 22 top-level ids happens at insert time into a new `transactions.top_category_id` column. `data.db` is `ATTACH`ed onto the `cache.db` connection as `userdata`, which lets one SQL statement resolve override → manual counterparty → live Pluggy → harvested Pluggy → learned counterparty → MCC, and lets the harvest run inside the walk's existing transaction. Two new write tools (`setCategory`, `setCounterpartyCategory`) reach storage through a `CategoryWriter` contract, because `.dependency-cruiser.js` forbids `mcp/` importing `storage/`.

**Tech Stack:** Node 24 native type stripping, `node:sqlite` (`ATTACH`, `PRAGMA user_version`), Zod at the MCP boundary, `node --test`, Stryker.

**Design document:** `docs/plans/2026-07-26-phase-3-categories-design.md`. Read it before Task 1. Where this plan and the design disagree, the design wins; where the design and the ADR disagree, this phase amends the ADR (Task 12).

---

## Before you start

```bash
nvm use          # v24.15.0. Node 18 makes `npm test` report "# tests 0" and exit 0
```

The check sequence, in this order, after every task:

```bash
npm run typecheck && npm run lint && npm run deps && npm test
```

`npm run mutation` is not part of that sequence. Run it at Task 11.

**Two facts that decide implementation details, both verified in the codebase:**

1. `mccOf` (`src/pluggy/transaction-mapper.ts:102`) stores the MCC as `String(number)`, and `wire.ts:100` types `payeeMCC` as `z.number()`. So a stored MCC is `"780"`, never `"0780"`, and seeding `mcc_categories.mcc` as TEXT from `String(row.mcc)` joins exactly. Do not add a `CAST`.
2. `toDigits` (`src/pluggy/transaction-mapper.ts:9`) returns `null` — never `""` — for an absent document. The derivation depends on this: SQLite equality on `NULL` yields `NULL`, so two rows with no document never join each other.

**One caveat to write down rather than design around.** SQLite guarantees an atomic commit across attached databases *except* in WAL mode, and `openDatabase` sets `journal_mode = WAL`. A crash mid-commit can therefore leave `cache.db` committed and `userdata` not, or the reverse. This is harmless here for one reason and one reason only: the snapshot never deletes and never writes a NULL over a value, so a half-applied harvest loses at most one walk's worth of new labels, which the next walk rewrites. Put that sentence in the docblock in Task 6. Do not "fix" it by dropping WAL.

---

## Task 1: Ship the category tree as code

Removes the per-read `GET /categories` call, which has the same tier exposure as the enrichment itself (design, D3).

**Files:**
- Create: `src/core/taxonomy-tree.ts`
- Modify: `src/core/taxonomy.ts`
- Test: `tests/core/taxonomy.test.ts`

**Step 1: Generate the constant from the recon table**

The authoritative copy of the tree is the table in `docs/research/2026-07-26-phase-0-5-recon.md`, starting at the line "Full tree, with this wallet's usage count per category." It has 130 rows. Depth is encoded by the `·` markers in the second column (none = top level, one = depth 2, two = depth 3), and rows are in id order, so a row's parent is the nearest preceding row one level shallower.

Write a throwaway parser in the scratchpad — not in the repo — and run it:

```bash
node "$SCRATCHPAD/build-taxonomy.mjs" > src/core/taxonomy-tree.ts
```

The parser reads the markdown table, computes `parentId` from the indentation rule above, and emits entries of the form `{ id: "05090001", parentId: "05090000" },`.

**Do not derive `parentId` from the id string.** The recon records three entries — `02030001`, `02030002`, `02030003` — whose real `parentId` is `02000000` even though their ids look like children of `02030000`. The table already places them at depth 2, so the indentation rule gets them right and a prefix rule gets them wrong.

The file:

```ts
import type { TaxonomyEntry } from "./taxonomy.ts";

/**
 * Pluggy's category tree, as returned by `GET /categories` on 2026-07-26 and
 * recorded in `docs/research/2026-07-26-phase-0-5-recon.md`.
 *
 * It ships as code rather than as a `cache.db` seed because `GET /categories`
 * is exposed to the same plan change as the transaction enrichment, and a
 * roll-up that stops working is an aggregate that stops working (design D3).
 *
 * Only `id` and `parentId` are here. The labels the user reads belong to the 22
 * top-level categories and already live in `category.ts`.
 *
 * `02030001`, `02030002` and `02030003` carry `parentId: "02000000"` while
 * their ids and their `parentDescription` both point at `02030000`. Pluggy
 * contradicts itself there; `parentId` is what we build from.
 */
export const TAXONOMY: readonly TaxonomyEntry[] = [
  { id: "01000000", parentId: null },
  // … 129 more
];
```

**Step 2: Write the failing tests**

Add to `tests/core/taxonomy.test.ts`:

```ts
import { TAXONOMY } from "../../src/core/taxonomy-tree.ts";
import { topCategoryOf } from "../../src/core/taxonomy.ts";
import { CATEGORY_IDS } from "../../src/core/category.ts";

describe("the shipped taxonomy", () => {
  it("carries every entry Pluggy served", () => {
    assert.equal(TAXONOMY.length, 130);
  });

  it("has exactly the 22 top-level categories as roots", () => {
    const roots = TAXONOMY.filter((entry) => entry.parentId === null).map((entry) => entry.id);
    assert.deepEqual([...roots].sort(), [...CATEGORY_IDS].sort());
  });

  it("rolls every entry up to one of the 22", () => {
    for (const entry of TAXONOMY) {
      assert.ok(CATEGORY_IDS.includes(topCategoryOf(entry.id) as never), `${entry.id} did not roll up`);
    }
  });

  it("keeps the three misfiled financing entries under Loans and financing", () => {
    for (const id of ["02030001", "02030002", "02030003"]) {
      assert.equal(topCategoryOf(id), "02000000");
    }
  });

  it("keeps the four nine-digit insurance children under Insurance", () => {
    for (const id of ["200100000", "200200000", "200300000", "200400000"]) {
      assert.equal(topCategoryOf(id), "20000000");
    }
  });

  const LOOKUP_CASES: readonly { readonly name: string; readonly id: string | null; readonly root: string | null }[] = [
    { name: "a leaf resolves to its root", id: "11010000", root: "11000000" },
    { name: "a root resolves to itself", id: "11000000", root: "11000000" },
    { name: "an id Pluggy added after this release resolves to nothing", id: "77770000", root: null },
    { name: "no category resolves to nothing", id: null, root: null },
  ];

  for (const { name, id, root } of LOOKUP_CASES) {
    it(name, () => {
      assert.equal(topCategoryOf(id), root);
    });
  }
});
```

**Step 3: Run them and watch them fail**

```bash
node --test tests/core/taxonomy.test.ts
```
Expected: FAIL — `topCategoryOf` is not exported.

**Step 4: Implement**

Append to `src/core/taxonomy.ts`:

```ts
import { TAXONOMY } from "./taxonomy-tree.ts";

const ROLLUP = buildRollup(TAXONOMY);

/**
 * The top-level ancestor of a Pluggy category id, or `null` when we do not know
 * the id.
 *
 * Returning `null` rather than throwing is the whole point: the tree ships as
 * code, so a category Pluggy adds tomorrow is absent by construction. An
 * unknown leaf must cost that one row its group, not take a whole account's
 * walk down with it (design D3).
 */
export function topCategoryOf(categoryId: string | null): CategoryId | null {
  if (categoryId === null) {
    return null;
  }
  return ROLLUP.get(categoryId) ?? null;
}
```

`buildRollup` keeps throwing on a duplicate id, a missing parent, a cycle or a root that is not top-level. Those are defects in the shipped constant and the tests above are what catch them — at module load, in CI, never at runtime against a user's wallet.

**Step 5: Verify**

```bash
node --test tests/core/taxonomy.test.ts
npm run typecheck
```
Expected: PASS.

**Step 6: Commit**

```bash
git add src/core/taxonomy-tree.ts src/core/taxonomy.ts tests/core/taxonomy.test.ts
git commit -m "feat: ship Pluggy's category tree as a code constant"
```

---

## Task 2: Attach data.db onto the cache connection

The derivation joins across both files and the harvest writes to both inside one transaction. Both need a single connection (design, "The derivation query").

**Files:**
- Modify: `src/storage/db.ts`
- Modify: `src/bin/cata-centavo.ts:70-83`, `:196-215`
- Test: `tests/storage/db.test.ts`

**Step 1: Write the failing tests**

```ts
describe("openDatabases", () => {
  it("exposes data.db as the userdata schema on the cache connection", () => {
    const databases = openDatabases(paths);
    try {
      const schemas = databases.db.prepare("PRAGMA database_list").all().map((row) => String(row["name"]));
      assert.ok(schemas.includes("userdata"));
    } finally {
      databases.close();
    }
  });

  it("versions the two schemas independently", () => {
    const databases = openDatabases(paths);
    try {
      assert.equal(schemaVersion(databases.db), targetVersion(CACHE_MIGRATIONS));
      assert.equal(schemaVersion(databases.db, "userdata"), targetVersion(DATA_MIGRATIONS));
    } finally {
      databases.close();
    }
  });

  it("refuses a data.db written by a newer release", () => {
    // stamp userdata to targetVersion(DATA_MIGRATIONS) + 1, reopen, expect SchemaTooNewError
  });

  it("keeps userdata intact when cache.db is rebuilt", () => {
    // write a row into userdata, stamp main's user_version to something unknown,
    // reopen, assert the userdata row survives
  });
});
```

Use real files under a `mkdtempSync` directory for the reopen cases; `:memory:` cannot be reopened. Follow whatever `tests/storage/db.test.ts` already does for temp paths.

**Step 2: Run and watch fail**

```bash
node --test tests/storage/db.test.ts
```
Expected: FAIL — `databases.db` is undefined, `schemaVersion` takes one argument.

**Step 3: Implement**

In `src/storage/db.ts`, thread an optional schema name through the version helpers:

```ts
const MAIN = "main";

export function schemaVersion(db: DatabaseSync, schema: string = MAIN): number {
  return readUserVersion(db, schema);
}

function readUserVersion(db: DatabaseSync, schema: string): number {
  const value = db.prepare(`PRAGMA ${quoteSchema(schema)}.user_version`).get()?.["user_version"];
  const version = Number(value);
  if (Number.isInteger(version)) {
    return version;
  }
  return 0;
}

function stamp(db: DatabaseSync, schema: string, version: number): void {
  if (!Number.isInteger(version) || version < 0) {
    throw new Error(`refusing to stamp a non-integer schema version: ${version}`);
  }
  db.exec(`PRAGMA ${quoteSchema(schema)}.user_version = ${version}`);
}

/** `PRAGMA` and `ATTACH … AS` take no bound parameters, which is why this exists. */
function quoteSchema(schema: string): string {
  if (!/^[a-z_][a-z0-9_]*$/u.test(schema)) {
    throw new Error(`refusing to interpolate an unsafe schema name: ${schema}`);
  }
  return schema;
}
```

`migrate`, `apply` and `dropEverything` take the schema too. `dropEverything` reads `${schema}.sqlite_master` and drops with a qualified name; it is still only ever called for `main` under the `rebuild` policy.

Then replace `openDatabases`:

```ts
export type Databases = {
  /** One connection. `main` is cache.db; `userdata` is data.db. */
  readonly db: DatabaseSync;
  close(): void;
};

/**
 * The two files of ADR §10 on one connection.
 *
 * They share a connection because Phase 3's derivation resolves a category by
 * reading both in one statement, and because the harvest writes the snapshot
 * inside the walk's transaction. Two handles cannot see each other and cannot
 * do either.
 */
export function openDatabases(paths: Paths): Databases {
  const db = openDatabase({ path: paths.cacheDb, migrations: CACHE_MIGRATIONS, policy: "rebuild" });

  try {
    db.exec(`ATTACH DATABASE '${escapeLiteral(paths.dataDb)}' AS userdata`);
    restrictToOwner(paths.dataDb);
    migrateSchema(db, { path: paths.dataDb, migrations: DATA_MIGRATIONS, policy: "migrate" }, "userdata");
  } catch (error) {
    db.close();
    throw error;
  }

  return { db, close: () => db.close() };
}
```

`escapeLiteral` doubles single quotes. `ATTACH` accepts a bound parameter in some drivers and not others; do not rely on it.

**Step 4: Update the two call sites in `src/bin/cata-centavo.ts`**

```ts
cacheVersion: schemaVersion(databases.db),
dataVersion: schemaVersion(databases.db, "userdata"),
```

```ts
store: createTransactionStore(databases.db),
```

**Step 5: Verify**

```bash
npm run typecheck && npm run lint && npm run deps && npm test
```
Expected: PASS.

**Step 6: Commit**

```bash
git add src/storage/db.ts src/bin/cata-centavo.ts tests/storage/db.test.ts
git commit -m "feat: attach data.db to the cache connection as userdata"
```

---

## Task 3: The migrations

Both must land in the same release. The `cache.db` bump is what re-walks every account, and that re-walk *is* the backfill — but it only harvests while the enrichment is still alive (design, "The harvest").

**Files:**
- Modify: `src/storage/migrations.ts`
- Test: `tests/storage/migrations.test.ts` (create)

**Step 1: Write the failing test**

```ts
describe("CACHE_MIGRATIONS", () => {
  it("seeds one row per MCC mapping", () => {
    const db = openDatabase({ path: ":memory:", migrations: CACHE_MIGRATIONS, policy: "rebuild" });
    const rows = db.prepare("SELECT mcc, category, samples, agreeing FROM mcc_categories ORDER BY mcc").all();
    assert.equal(rows.length, MCC_CATEGORIES.length);
  });

  it("seeds the MCC as the text form the mapper writes", () => {
    // MCC 780 must be stored as "780" so it joins transactions.mcc, which
    // transaction-mapper.ts writes as String(payeeMCC).
    const row = db.prepare("SELECT category FROM mcc_categories WHERE mcc = '780'").get();
    assert.equal(row?.["category"], "05000000");
  });

  it("replays from zero against a dropped file", () => {
    // open twice under `rebuild` with a stamped-wrong user_version; no error
  });
});

describe("DATA_MIGRATIONS", () => {
  it("creates the three tables the derivation reads", () => {
    // PRAGMA userdata.table_info on each of category_overrides,
    // counterparty_categories, category_snapshot
  });
});
```

**Step 2: Run and watch fail**

```bash
node --test tests/storage/migrations.test.ts
```
Expected: FAIL — no such table `mcc_categories`.

**Step 3: Implement**

Append to `CACHE_MIGRATIONS`. Note the docblock already on the array: under `rebuild`, `apply` replays from 0, so entry 2 must be additive. `ALTER TABLE` is additive and legal here; a second `CREATE TABLE transactions` would not be.

```ts
import { MCC_CATEGORIES } from "../core/mcc.ts";

/**
 * The MCC seed is generated from `src/core/mcc.ts` so the table has one source.
 * Values are interpolated rather than bound because a migration's `up` is a
 * script, not a statement — the inputs are a compile-time constant of integers
 * and closed-list category ids, so there is no untrusted string here.
 */
function seedMccCategories(): string {
  return MCC_CATEGORIES
    .map((row) => `INSERT INTO mcc_categories (mcc, category, samples, agreeing) VALUES ('${row.mcc}', '${row.category}', ${row.samples}, ${row.agreeing});`)
    .join("\n");
}

// … appended to CACHE_MIGRATIONS
{
  to: 2,
  up: `
    ALTER TABLE transactions ADD COLUMN top_category_id TEXT;
    CREATE INDEX transactions_by_document ON transactions(document);

    CREATE TABLE mcc_categories (
      mcc TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      samples INTEGER NOT NULL,
      agreeing INTEGER NOT NULL
    );
    ${seedMccCategories()}
  `,
},
```

And the first entry `data.db` has ever had:

```ts
/** Never dropped: overrides, rules and closing days live here (§10). */
export const DATA_MIGRATIONS: readonly Migration[] = [
  {
    to: 1,
    up: `
      CREATE TABLE category_overrides (
        transaction_id TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE counterparty_categories (
        document TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        origin TEXT NOT NULL,
        samples INTEGER,
        agreeing INTEGER,
        created_at TEXT NOT NULL
      );

      CREATE TABLE category_snapshot (
        transaction_id TEXT PRIMARY KEY,
        category_id TEXT NOT NULL,
        top_category_id TEXT,
        harvested_at TEXT NOT NULL
      );
    `,
  },
];
```

`origin` is `manual` or `learned`; `samples` and `agreeing` are NULL on manual rows. One row per document: a manual write over a learned document replaces it.

`category_snapshot.top_category_id` is nullable because a leaf absent from the shipped tree still gets snapshotted — the leaf is the durable part, and a later release that learns the leaf can recompute the root from it.

**Step 4: Verify**

```bash
node --test tests/storage/migrations.test.ts && npm run typecheck
```
Expected: PASS.

**Step 5: Commit**

```bash
git add src/storage/migrations.ts tests/storage/migrations.test.ts
git commit -m "feat: add the category schema to both databases"
```

---

## Task 4: Roll up on write

**Files:**
- Modify: `src/storage/transactions.ts:6-39`, `:246-254`
- Modify: `src/bin/cata-centavo.ts:208-213`
- Test: `tests/storage/transactions.test.ts`

**Step 1: Write the failing tests**

```ts
it("stores the top-level ancestor of the leaf Pluggy sent", () => {
  const store = storeFor();
  store.replaceAccount("acc-1", "conn-1", [tx({ id: "a", categoryId: "11010000" })], null);

  const row = rawDb.prepare("SELECT top_category_id FROM transactions WHERE id = 'a'").get();
  assert.equal(row?.["top_category_id"], "11000000");
});

it("keeps the leaf and warns when the tree does not know it, instead of failing the walk", () => {
  const log = fakeLogger();
  const store = storeFor(log);

  store.replaceAccount("acc-1", "conn-1", [tx({ id: "a", categoryId: "77770000" })], null);

  const row = rawDb.prepare("SELECT category_id, top_category_id FROM transactions WHERE id = 'a'").get();
  assert.equal(row?.["category_id"], "77770000");
  assert.equal(row?.["top_category_id"], null);
  assert.ok(log.lines.some((line) => line.level === "warn" && line.message.includes("category")));
});

it("stores no top-level category for an uncategorized row", () => {
  // categoryId: null → top_category_id null, no warning
});
```

`storeFor` needs to hand back the `DatabaseSync` as well as the store so the tests can read the raw column. Adjust the helper.

**Step 2: Run and watch fail**

```bash
node --test tests/storage/transactions.test.ts
```
Expected: FAIL — no such column `top_category_id`.

**Step 3: Implement**

`createTransactionStore` now takes a logger:

```ts
export function createTransactionStore(db: DatabaseSync, log: Logger): TransactionStore {
```

Add `"top_category_id"` to `TRANSACTION_COLUMNS` and to the `ON CONFLICT DO UPDATE SET` list. `transactionValues` becomes a function of the row and the logger:

```ts
function transactionValues(row: Transaction, log: Logger): readonly (string | number | null)[] {
  return [ /* … unchanged … */, topCategoryFor(row, log)];
}

/**
 * The roll-up runs here, at insert, so SQL only ever compares a 22-valued
 * column against a 22-valued filter (design D2). Doing it at read time is what
 * let `categories: ["11000000"]` silently exclude every row tagged `11010000`.
 */
function topCategoryFor(row: Transaction, log: Logger): CategoryId | null {
  const top = topCategoryOf(row.categoryId);
  if (top === null && row.categoryId !== null) {
    log.warn({ transactionId: row.id, categoryId: row.categoryId }, "Unknown category, left ungrouped");
  }
  return top;
}
```

`rowToTransaction` does **not** read `top_category_id`. It is storage's business, not the domain type's — the derived category reaches callers through Task 6's `DerivedTransaction`.

Update the composition root: `createTransactionStore(databases.db, log)`.

**Step 4: Verify**

```bash
npm run typecheck && npm run deps && npm test
```
Expected: PASS. `npm run deps` matters here — `storage/` importing `core/` is allowed, the reverse is not.

**Step 5: Commit**

```bash
git add src/storage/transactions.ts src/bin/cata-centavo.ts tests/storage/transactions.test.ts
git commit -m "feat: roll transactions up to a top-level category on write"
```

---

## Task 5: The branch order, in one place

The precedence and the reported provenance come from the same array so they cannot drift. A `category_src` that disagrees with its own value is a confidently wrong number about where a number came from.

**Files:**
- Create: `src/core/category-source.ts`
- Test: `tests/core/category-source.test.ts` (create)

**Step 1: Write the failing test**

```ts
const ALL: DerivedColumns = {
  override: "01000000", counterparty: "02000000", pluggy: "03000000",
  snapshot: "04000000", learned: "05000000", mcc: "06000000",
};

const PRECEDENCE_CASES: readonly { readonly name: string; readonly columns: DerivedColumns; readonly category: string | null; readonly source: CategorySource | null }[] = [
  { name: "an override beats everything", columns: ALL, category: "01000000", source: "override" },
  { name: "a manual counterparty beats Pluggy", columns: { ...ALL, override: null }, category: "02000000", source: "counterparty" },
  { name: "live Pluggy beats the harvest", columns: { ...ALL, override: null, counterparty: null }, category: "03000000", source: "pluggy" },
  { name: "the snapshot answers once live Pluggy goes quiet", columns: { ...ALL, override: null, counterparty: null, pluggy: null }, category: "04000000", source: "pluggy" },
  { name: "a learned counterparty beats the MCC", columns: { override: null, counterparty: null, pluggy: null, snapshot: null, learned: "05000000", mcc: "06000000" }, category: "05000000", source: "learned" },
  { name: "the MCC is the last resort", columns: { override: null, counterparty: null, pluggy: null, snapshot: null, learned: null, mcc: "06000000" }, category: "06000000", source: "mcc" },
  { name: "nothing matched", columns: { override: null, counterparty: null, pluggy: null, snapshot: null, learned: null, mcc: null }, category: null, source: null },
];

for (const { name, columns, category, source } of PRECEDENCE_CASES) {
  it(name, () => {
    assert.deepEqual(resolveCategory(columns), { category, categorySrc: source });
  });
}
```

Note the fourth case: the snapshot reports `pluggy`, not `snapshot`. To the user, a remembered Pluggy answer and a live one are the same answer; what separates them is which file survives a rebuild (design D1).

**Step 2: Run and watch fail**

```bash
node --test tests/core/category-source.test.ts
```
Expected: FAIL — module not found.

**Step 3: Implement**

```ts
import type { CategoryId } from "./category.ts";

/**
 * The derivation, in precedence order. This array is the single source of
 * truth: `storage/category-sql.ts` generates the SQL `COALESCE` from it and
 * `resolveCategory` walks it, so the order and the reported provenance cannot
 * drift apart (design, "The derivation query").
 */
export const BRANCHES = ["override", "counterparty", "pluggy", "snapshot", "learned", "mcc"] as const;

export type Branch = (typeof BRANCHES)[number];

/** What the user is told about where a category came from. */
export type CategorySource = "override" | "counterparty" | "pluggy" | "learned" | "mcc";

/** A harvested Pluggy answer is still a Pluggy answer. */
const REPORTED: Readonly<Record<Branch, CategorySource>> = {
  override: "override",
  counterparty: "counterparty",
  pluggy: "pluggy",
  snapshot: "pluggy",
  learned: "learned",
  mcc: "mcc",
};

export type DerivedColumns = Readonly<Record<Branch, string | null>>;

export type ResolvedCategory = {
  readonly category: CategoryId | null;
  readonly categorySrc: CategorySource | null;
};

export function resolveCategory(columns: DerivedColumns): ResolvedCategory {
  for (const branch of BRANCHES) {
    const value = columns[branch];
    if (value !== null) {
      return { category: value as CategoryId, categorySrc: REPORTED[branch] };
    }
  }
  return { category: null, categorySrc: null };
}
```

**Step 4: Verify**

```bash
node --test tests/core/category-source.test.ts && npm run typecheck
```
Expected: PASS.

**Step 5: Commit**

```bash
git add src/core/category-source.ts tests/core/category-source.test.ts
git commit -m "feat: define the category derivation order once"
```

---

## Task 6: Derive the category in SQL

**Files:**
- Create: `src/storage/category-sql.ts`
- Modify: `src/core/transaction.ts`, `src/core/contracts.ts`, `src/storage/transactions.ts:92-141`, `:187-194`
- Test: `tests/storage/categories.test.ts` (create)

**Step 1: Add the domain type**

In `src/core/transaction.ts`:

```ts
/** A cached transaction plus the category the derivation resolved for it. */
export type DerivedTransaction = Transaction & ResolvedCategory;
```

In `src/core/contracts.ts`, widen the filter and the store:

```ts
/** A top-level category id, or the absence of one. */
export type CategoryFilterValue = CategoryId | "none";

export type TransactionFilter = {
  // …
  readonly categories?: readonly CategoryFilterValue[];
  // …
};

export type TransactionStore = {
  // …
  query(filter: TransactionFilter): readonly DerivedTransaction[];
  byIds(ids: readonly string[]): readonly DerivedTransaction[];
  // …
};
```

`TransactionReader` in `src/core/transactions.ts` follows.

**Step 2: Write the failing tests**

`tests/storage/categories.test.ts`. Six rows, one per branch, then precedence pairwise:

```ts
it("resolves each branch in isolation", () => { /* table test over the six */ });

it("prefers the override to everything else", () => { /* … */ });

it("keeps an override after cache.db is rebuilt", () => {
  // ADR §12.11 asks for exactly this: write an override, force a cache rebuild
  // by stamping main's user_version, re-walk, assert the override still wins.
});

it("filters by a top-level id and returns rows tagged with its children", () => {
  const store = seeded([tx({ id: "child", categoryId: "11010000" })]);
  assert.deepEqual(idsOf(store.query({ ...WIDE, categories: ["11000000"] })), ["child"]);
});

it("filters uncategorized rows with \"none\"", () => { /* … */ });

it("mixes \"none\" with real ids", () => { /* … */ });

it("never joins two rows that both have no document", () => {
  // two rows, document null, a learned mapping for some other CNPJ:
  // neither row picks it up
});
```

The regression test is the fourth one. Delete the existing case at `tests/storage/transactions.test.ts:132` named `"filters by leaf category"` — it asserts the bug. Do not keep it renamed.

**Step 3: Run and watch fail**

```bash
node --test tests/storage/categories.test.ts
```

**Step 4: Implement `src/storage/category-sql.ts`**

```ts
import { BRANCHES } from "../core/category-source.ts";

/**
 * The six branches as six columns. Resolution happens in
 * `core/category-source.ts`, driven by the same array that builds this.
 *
 * There is deliberately no `CREATE VIEW`. A view living in the droppable file
 * and referencing `userdata.` would couple `cache.db`'s schema to a schema name
 * that has to be attached already — including during the migration run at
 * startup, before any attach has happened.
 */
export const DERIVED_COLUMNS = `
  (SELECT o.category FROM userdata.category_overrides o
     WHERE o.transaction_id = t.id)                                AS c_override,
  (SELECT c.category FROM userdata.counterparty_categories c
     WHERE c.document = t.document AND c.origin = 'manual')        AS c_counterparty,
  t.top_category_id                                                AS c_pluggy,
  (SELECT s.top_category_id FROM userdata.category_snapshot s
     WHERE s.transaction_id = t.id)                                AS c_snapshot,
  (SELECT c.category FROM userdata.counterparty_categories c
     WHERE c.document = t.document AND c.origin = 'learned')       AS c_learned,
  (SELECT m.category FROM mcc_categories m WHERE m.mcc = t.mcc)    AS c_mcc
`;

export const DERIVED_CATEGORY = `COALESCE(${BRANCHES.map((branch) => `c_${branch}`).join(", ")})`;
```

Rewrite `queryTransactions` around a CTE. The cheap filters stay in the inner query so the six correlated subqueries only run against rows that already survived them:

```sql
WITH derived AS (
  SELECT <columns>, ${DERIVED_COLUMNS}
  FROM transactions t
  WHERE <account, date, amount, account-type and keyset filters>
)
SELECT * FROM derived
[WHERE <category condition>]
ORDER BY local_date DESC, id DESC
[LIMIT ?]
```

`addCategoryFilter` moves to the outer query and learns `"none"`:

```ts
function categoryCondition(categories: readonly CategoryFilterValue[]): { readonly sql: string; readonly parameters: readonly string[] } {
  // Stryker disable next-line ConditionalExpression,BlockStatement: an empty category filter must remain an explicit no-match query.
  if (categories.length === 0) {
    return { sql: "1 = 0", parameters: [] };
  }
  const ids = categories.filter((value) => value !== "none");
  const wantsNone = categories.length !== ids.length;

  const clauses: string[] = [];
  if (ids.length > 0) {
    clauses.push(`${DERIVED_CATEGORY} IN (${placeholders(ids.length)})`);
  }
  if (wantsNone) {
    clauses.push(`${DERIVED_CATEGORY} IS NULL`);
  }
  return { sql: `(${clauses.join(" OR ")})`, parameters: ids };
}
```

`rowToTransaction` gains the resolution:

```ts
function rowToDerived(row: Record<string, unknown>): DerivedTransaction {
  return {
    ...rowToTransaction(row),
    ...resolveCategory({
      override: nullableString(row["c_override"]),
      counterparty: nullableString(row["c_counterparty"]),
      pluggy: nullableString(row["c_pluggy"]),
      snapshot: nullableString(row["c_snapshot"]),
      learned: nullableString(row["c_learned"]),
      mcc: nullableString(row["c_mcc"]),
    }),
  };
}
```

`findByIds` uses the same CTE with `id IN (…)` as its inner filter.

**Step 5: Verify**

```bash
npm run typecheck && npm run lint && npm run deps && npm test
```
Expected: PASS. Tests elsewhere will need their fakes updated to return `DerivedTransaction`; add `category` and `categorySrc` to `tests/fakes/transaction-builder.ts` behind a second builder, `derived(overrides)`, rather than widening `tx`.

**Step 6: Commit**

```bash
git add src/core/transaction.ts src/core/contracts.ts src/core/transactions.ts src/storage/category-sql.ts src/storage/transactions.ts tests/
git commit -m "feat: derive a transaction's category across both databases"
```

---

## Task 7: Learn a counterparty's category

Pure logic first, no I/O. CNPJ only — a CPF is a person, and "CPF X → Transfers" stamped retroactively over every transfer to your brother is exactly the confidently wrong number the PRD's first rule forbids (design D4).

**Files:**
- Create: `src/core/counterparty.ts`
- Test: `tests/core/counterparty.test.ts` (create)

**Step 1: Write the failing tests**

```ts
const DOCUMENT_CASES: readonly { readonly name: string; readonly value: string; readonly valid: boolean; readonly learnable: boolean }[] = [
  { name: "a CNPJ is valid and learnable", value: "12345678000190", valid: true, learnable: true },
  { name: "a CPF is valid but never learned", value: "12345678900", valid: true, learnable: false },
  { name: "eight digits is neither", value: "12345678", valid: false, learnable: false },
  { name: "an empty document is neither", value: "", valid: false, learnable: false },
];

const LEARNING_CASES: readonly { readonly name: string; readonly labels: readonly string[]; readonly winner: string | null }[] = [
  { name: "unanimous", labels: ["10000000", "10000000", "10000000"], winner: "10000000" },
  { name: "a true majority wins", labels: ["10000000", "10000000", "11000000"], winner: "10000000" },
  { name: "an exact tie is not broken", labels: ["10000000", "11000000"], winner: null },
  { name: "a plurality short of a majority loses", labels: ["10000000", "10000000", "11000000", "12000000", "13000000"], winner: null },
  { name: "a single sample is a majority of one", labels: ["10000000"], winner: "10000000" },
];
```

Plus: a CPF's rows are dropped entirely; a row with no category contributes nothing; the winner carries `samples` and `agreeing`.

**Step 2: Run and watch fail.**

**Step 3: Implement**

```ts
/**
 * A document we accept from a human. Both lengths are usable manually; only a
 * CNPJ is ever learned from data (design D4).
 */
export function isDocument(value: string): boolean {
  return value.length === 11 || value.length === 14;
}

export function isCnpj(value: string): boolean {
  return value.length === 14;
}

export type LabelledRow = {
  readonly document: string | null;
  readonly category: string | null;
};

export type LearnedCounterparty = {
  readonly document: string;
  readonly category: CategoryId;
  readonly samples: number;
  readonly agreeing: number;
};

/**
 * A document's category, when its rows agree by a true majority.
 *
 * A plurality is not enough. `mcc.ts` maps by plurality and says so, but an MCC
 * is a line of business shared by thousands of merchants, while a CNPJ is one
 * merchant — a 12-of-25 CNPJ mapping is a coin flip applied retroactively to
 * everything that merchant ever sold you.
 */
export function learnCounterparties(rows: readonly LabelledRow[]): readonly LearnedCounterparty[] {
  // group by document where isCnpj(document) and category !== null,
  // count per category, keep the winner when agreeing * 2 > samples
}
```

`samples` and `agreeing` ride along on the row, as `mcc.ts` carries them, so `doctor` can later surface a weak mapping as one.

**Step 4: Verify.** **Step 5: Commit** — `"feat: learn a counterparty's category from a true majority"`.

---

## Task 8: Harvest inside the walk

**Files:**
- Modify: `src/storage/transactions.ts:76-90`
- Test: `tests/storage/harvest.test.ts` (create)

**Step 1: Write the failing tests**

```ts
it("snapshots every categorized row", () => { /* … */ });

it("never writes a null over a remembered category", () => {
  const store = seeded();
  store.replaceAccount("acc-1", "conn-1", [tx({ id: "a", categoryId: "11010000" })], "1");

  store.replaceAccount("acc-1", "conn-1", [tx({ id: "a", categoryId: null })], "2");

  const row = raw.prepare("SELECT top_category_id FROM userdata.category_snapshot WHERE transaction_id = 'a'").get();
  assert.equal(row?.["top_category_id"], "11000000");
});

it("updates the snapshot when Pluggy changes its mind", () => { /* categorized → differently categorized */ });

it("learns a CNPJ's category and leaves CPFs alone", () => { /* … */ });

it("recomputes the learned map wholesale without touching manual rows", () => {
  // write a manual row for CNPJ A, walk with data that would learn a different
  // category for A: the manual row survives with origin 'manual'
});

it("rolls back both files when a row is rejected", () => {
  // the snapshot must not gain a row from a walk that threw
});
```

The second test is the whole phase in one assertion. If it passes, today's 99.7% survives the tier change; if it fails, the first sync after the window erases the history.

**Step 2: Run and watch fail.**

**Step 3: Implement**

Inside `replaceAccount`, between the inserts and the `COMMIT`:

```ts
/**
 * Harvest the enrichment while it still exists (design, "The harvest").
 *
 * Two steps, both inside the walk's transaction. The snapshot only ever gains:
 * a row with no category writes nothing, so a walk that arrives after the plan
 * drops to free cannot erase what an earlier walk remembered. The learned map
 * is recomputed wholesale — about two thousand rows, and it means a manual
 * correction, a re-sync and a cache rebuild all converge on the same map
 * instead of accumulating drift.
 *
 * SQLite's cross-database atomic commit does not hold under WAL, which
 * `openDatabase` enables. A crash can therefore commit one file and not the
 * other. That is survivable here precisely because of the asymmetry above: the
 * worst case is one walk's new labels lost, which the next walk rewrites.
 */
function harvest(options: ReplaceAccountOptions): void {
  snapshotCategories(options);
  relearnCounterparties(options);
}
```

Step 1, per row with a non-null `categoryId`:

```sql
INSERT INTO userdata.category_snapshot (transaction_id, category_id, top_category_id, harvested_at)
VALUES (?, ?, ?, ?)
ON CONFLICT(transaction_id) DO UPDATE SET
  category_id = excluded.category_id,
  top_category_id = excluded.top_category_id,
  harvested_at = excluded.harvested_at
```

Step 2 reads the labelled pairs across the whole cache — not just this account, since a merchant sells to more than one of your cards — feeds them to `learnCounterparties`, then:

```sql
DELETE FROM userdata.counterparty_categories WHERE origin = 'learned';
INSERT INTO userdata.counterparty_categories (document, category, origin, samples, agreeing, created_at)
VALUES (?, ?, 'learned', ?, ?, ?)
ON CONFLICT(document) DO NOTHING
```

The `DELETE` only touches learned rows, so manual ones survive; `DO NOTHING` then declines to overwrite a manual row for a document that would also have been learned.

The pair query must read the derived category, not `top_category_id` — a row whose category came from a manual override is the strongest evidence there is:

```sql
SELECT t.document AS document, ${DERIVED_CATEGORY} AS category
FROM (SELECT t.*, ${DERIVED_COLUMNS} FROM transactions t WHERE t.document IS NOT NULL) t
```

`harvested_at` and `created_at` need a clock. `createTransactionStore` takes a `Clock` alongside the logger; `bin/` already has `systemClock`, and `tests/fakes/fixed-clock.ts` exists.

**Step 4: Verify.** **Step 5: Commit** — `"feat: harvest categories into data.db on every walk"`.

---

## Task 9: `setCategory` and `setCounterpartyCategory`

`.dependency-cruiser.js` forbids `mcp/` importing `storage/` (`only-bin-builds-infrastructure`), so the tools reach storage through a contract.

**Files:**
- Modify: `src/core/contracts.ts`
- Create: `src/storage/categories.ts`
- Create: `src/mcp/tools/set-category.ts`
- Modify: `src/mcp/source.ts`, `src/mcp/tools/result.ts`, `src/mcp/server.ts`, `src/bin/cata-centavo.ts`
- Test: `tests/storage/categories.test.ts`, `tests/mcp/tools/set-category.test.ts` (create)

**Step 1: The contract**

```ts
/** The category writes `data.db` accepts. Both are retroactive by construction. */
export type CategoryWriter = {
  setCategory(ids: readonly string[], category: CategoryId): {
    readonly updated: number;
    readonly unknownIds: readonly string[];
  };
  /** `affected` counts cached rows that now resolve through this document. */
  setCounterpartyCategory(document: string, category: CategoryId): { readonly affected: number };
};
```

**Step 2: Write the failing storage tests**

```ts
it("writes an override for every known id and names the rest", () => { /* … */ });
it("overwrites an earlier override", () => { /* … */ });
it("replaces a learned counterparty row and flips it to manual", () => { /* … */ });
it("counts the rows a counterparty write now answers for", () => {
  // three rows share the CNPJ, one of them has an override:
  // affected === 2
});
```

`affected` counts rows the write actually changes the answer for, which is rows with that document and no override — an override outranks the counterparty branch, so those rows are unmoved and counting them would overstate the blast radius:

```sql
SELECT COUNT(*) AS affected FROM transactions t
WHERE t.document = ?
  AND NOT EXISTS (SELECT 1 FROM userdata.category_overrides o WHERE o.transaction_id = t.id)
```

**Step 3: Write the failing tool tests**

```ts
it("rejects a category outside the closed list", () => { /* isError, readable text */ });
it("rejects more than 100 ids", () => { /* … */ });
it("rejects a document that is neither 11 nor 14 digits", () => { /* … */ });
it("strips punctuation from a document", () => { /* 12.345.678/0001-90 reaches storage as digits */ });
it("reports unknown ids as content and still writes the known ones", () => { /* … */ });
it("passes the category through to the writer", () => { /* the rule npm run mutation checks */ });
```

**Step 4: Implement**

`src/storage/categories.ts` exports `createCategoryWriter(db, clock)`.

`src/mcp/tools/set-category.ts`:

```ts
const categoryInput = z.string().refine(isCategoryId, "must be a known category id");

const setCategoryInput = z.object({
  transactionIds: z.array(z.string().min(1)).min(1).max(100),
  category: categoryInput,
});

const setCounterpartyCategoryInput = z.object({
  document: z.string().min(1),
  category: categoryInput,
});
```

The 100 cap matches `listTransactions`' page size, so a full page of uncategorized rows can be corrected in one call. Strip punctuation from `document` before the length check, then reject anything that is not 11 or 14 digits.

Descriptions follow the three-part template:

```
Corrects the category of specific transactions.

Use this tool when:
- The user tells you a transaction is in the wrong category.
- You listed uncategorized transactions with categories: ["none"] and the user said what they are.

Returns: How many transactions were corrected, and any ids that are not in the local cache.
```

```
Assigns a category to everyone a CPF or CNPJ identifies, backwards and forwards.

Use this tool when:
- The user tells you what a merchant is, rather than what one transaction is.
- The same counterparty keeps landing in the wrong category.

Returns: The document, the category, and how many cached transactions now resolve through it. That count is the blast radius — read it back to the user when it is larger than they expected.
```

Unknown ids come back as readable content, not a protocol error (PRD item 4): the model should re-list and retry, and it cannot see what it cannot read.

There is no unset tool. Setting a different category is the undo, and a delete verb can arrive later at no migration cost.

**Step 5: Wire it.** `Source` gains `writer: CategoryWriter`, `ToolDeps` gains `writer: CategoryWriter | null` beside `reader`, `createServer` registers both tools, and `createReadySource` builds the writer from `databases.db`.

**Step 6: Verify**

```bash
npm run typecheck && npm run lint && npm run deps && npm test
```

**Step 7: Commit** — `"feat: add the category write tools"`.

---

## Task 10: Read the derived category, and delete `getCategories`

**Files:**
- Modify: `src/core/aggregate.ts`, `src/mcp/tools/transactions.ts`, `src/mcp/tools/list-transactions.ts`, `src/mcp/tools/transaction-details.ts`, `src/mcp/tools/transaction-input.ts`
- Delete from: `src/core/contracts.ts` (`Bank.getCategories`), `src/pluggy/client.ts`, `src/pluggy/wire.ts`, `tests/fakes/fake-bank.ts`, `tests/pluggy/client.test.ts`
- Test: `tests/core/aggregate.test.ts`, `tests/mcp/tools/transactions.test.ts`

**Step 1: Write the failing tests**

```ts
it("groups by the derived category rather than the leaf", () => { /* … */ });
it("accepts \"none\" in the categories filter", () => { /* reaches the filter */ });
it("reports where each row's category came from", () => { /* categorySrc in the payload */ });
it("does not call the bank for a taxonomy", () => {
  // fakeBank has no getCategories to call any more; assert calls contains no
  // "categories" entry
});
```

**Step 2: Implement**

`aggregate` loses its `rollup` parameter — the rows arrive carrying `category` already:

```ts
export function aggregate(rows: readonly DerivedTransaction[], today: string): Aggregate
```

`rolledCategory` and its throw go away. `SELF_TRANSFER_LEAVES` keeps reading `row.categoryId`, the leaf: those five ids are leaves and the leaf is still stored.

Both read tools drop `buildRollup(await bank.getCategories())`. `formatListRow` returns `row.category` and `row.categorySrc`. `formatDetail` gains `category` and `categorySrc` beside the existing `categoryId`, which stays — the leaf is the finer answer and detail is where fine answers belong.

`categoryInput` in `transaction-input.ts` and both read tools accepts `"none"`:

```ts
const categoryFilterInput = z.string().refine(
  (value) => value === "none" || isCategoryId(value),
  "must be a known category id, or \"none\" for uncategorized",
);
```

Update the three tool descriptions to mention `"none"` and `categorySrc`. Run the prose through the `humanizer` skill.

Then delete `getCategories` from `Bank`, from `createPluggyClient` (the memoized `categories` promise at `client.ts:49-59`), from `wire.ts` (`CATEGORY_PAGE`, `parseCategoryPage`), from `fake-bank.ts`, and the client test that covers it. This is a feature branch: delete outright, no shim.

**Step 3: Verify**

```bash
npm run typecheck && npm run lint && npm run deps && npm test
```
`npm run deps` should now report one fewer orphan risk, not one more; if `wire.ts` leaves a dangling export, remove it.

**Step 4: Commit** — `"feat: serve categories from the derivation instead of the network"`.

---

## Task 11: Prove it survives the tier change

The acceptance test the design adds, and the only one that proves the phase did its job without waiting fifteen days.

**Files:**
- Create: `tests/storage/tier-change.test.ts`
- Modify: `stryker.config.json`

**Step 1: Write the test**

```ts
/**
 * The phase's reason to exist, as an assertion.
 *
 * The same synthetic wallet is walked twice: once as Pluggy answers today, then
 * again with every `category` nulled, as though the plan had already dropped to
 * free. Every aggregate, every group total and every filtered query must return
 * the same numbers. What may legitimately change is `categorySrc`.
 */
it("returns the same numbers after the enrichment stops", () => {
  const store = storeFor();
  store.replaceAccount("acc-1", "conn-1", ENRICHED, "1");
  const before = aggregate(store.query(WIDE), TODAY);

  store.replaceAccount("acc-1", "conn-1", ENRICHED.map((row) => ({ ...row, categoryId: null })), "2");
  const after = aggregate(store.query(WIDE), TODAY);

  assert.deepEqual(after.groups, before.groups);
  assert.equal(after.spentCents, before.spentCents);
  assert.equal(after.receivedCents, before.receivedCents);
});
```

`ENRICHED` is a synthetic wallet built with `tx()` — never a real statement, the repo is public. Give it enough shape to exercise all three fallbacks: rows with a CNPJ that a majority labels, rows with an MCC in `MCC_CATEGORIES`, rows with neither, and at least one row carrying a manual override written between the two walks.

Rows with neither a document nor an MCC will go uncategorized after the second walk *unless* the snapshot answers — which is exactly what makes this test meaningful. If it passes only because the wallet is all cards, it proves nothing; include bank rows.

**Step 2: Run it**

```bash
node --test tests/storage/tier-change.test.ts
```
Expected: PASS. If it fails, the harvest is not writing what it should, and no later task compensates.

**Step 3: Widen mutation coverage**

The derivation moved into `src/storage/`, so `stryker.config.json`'s `mutate` array has to cover it. **Use a glob, not a list of filenames.** The array named `src/storage/transactions.ts` individually, which means every new file in that directory — and every function later extracted *out* of that file into a new one — leaves the mutate set silently, with the score staying flat because the code simply stopped being measured:

```json
"mutate": ["src/core/**/*.ts", "src/pluggy/**/*.ts", "src/storage/**/*.ts", "src/mcp/format.ts"]
```

`incremental: true` is on, so after changing the glob, run once with `npx stryker run --incremental=false` and delete `reports/mutation/stryker-incremental.json` first. Otherwise the cached run reports the old file set, and an unchanged score reads as "nothing regressed" when it actually means "nothing was measured".

**Step 4: Run the whole sequence, then mutation**

```bash
npm run typecheck && npm run lint && npm run deps && npm test && npm run build
npm run mutation
```

Read the survivors. Either write the missing assertion or suppress with a reason. Pay particular attention to survivors in `category-source.ts` — a mutant that reorders `BRANCHES` and survives means the precedence tests are not actually pinning precedence.

**Step 5: Commit** — `"test: prove the aggregates survive the tier change"`.

---

## Task 12: Record what changed

**Files:**
- Modify: `docs/adr/0001-stack-and-architecture.md` (§12), `docs/prd.md`, `README.md`

**Step 1: Amend ADR §12**

§12 is built on "the free tier returns `category: null`", which is currently false and about to become true. Record: the chain is six branches, not three; the roll-up happens on write into `top_category_id`; the tree ships as code; the derivation is a SQL constant, not a view; CPF is never learned. §12.3's V1/V2 SQL is superseded by `src/storage/category-sql.ts`.

**Step 2: Amend the PRD**

Phase 3's line describes seeding the taxonomy into `cache.db`; that is the approach D2 rejects. Rewrite it as the harvest, and add the fourth acceptance criterion from Task 11. Open decision 7 stays open — this phase preserves the ability to answer it rather than answering it.

**Step 3: The README asymmetry**

This belongs in the README because a user will otherwise discover it by being confused:

> The counterparty map is learned from your own data, on your own machine, and is never shipped with the tool — a CNPJ→category mapping is a line of somebody's bank statement. If you install after your provider stops enriching transactions, there is nothing to learn it from, and you get merchant-code categorization on cards plus whatever you correct by hand.

**Step 4: Run prose through the `humanizer` skill.**

**Step 5: Commit** — `"docs: record the Phase 3 category design"`.

---

## What this plan does not build

Named so nobody adds them mid-flight:

- **The `description_norm` → category map.** The only signal that reaches the 259 rows (14.8%) with neither an MCC nor a document, and the only cut here with an expiry date. Deliberate, on YAGNI.
- **The V2 rule engine** (ADR §12.9).
- **Learning from CPF.** Manual `setCounterpartyCategory` still covers it.
- **Granularity finer than the 22.** The leaf survives in both `transactions.category_id` and the snapshot, so this is deferred, not foreclosed.
- **An unset tool.** Overwrite is the undo.
- **`doctor` reporting harvest coverage or weak mappings.** Natural next step, out of scope.

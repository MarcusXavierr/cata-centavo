import assert from "node:assert/strict";
import { describe, it, test } from "node:test";

import { CATEGORY_IDS, CATEGORIES } from "../../src/core/category.ts";
import { buildRollup, topCategoryOf, type TaxonomyEntry } from "../../src/core/taxonomy.ts";
import { TAXONOMY } from "../../src/core/taxonomy-tree.ts";

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

  assert.equal(rollup.get("200100000"), "20000000");
  assert.equal(rollup.has("20010000"), false);
});

test("buildRollup trusts parentId over any description", () => {
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


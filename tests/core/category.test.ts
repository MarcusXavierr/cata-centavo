import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CATEGORIES, CATEGORY_IDS, categoryById, isCategoryId } from "../../src/core/category.ts";

/**
 * Pluggy's top-level ids, written out independently of the module under test so
 * a slip in either transcription shows up as a failure. The shape is regular on
 * purpose — 01 through 21 in sequence plus the 99999999 escape hatch — which is
 * what makes a typo visible to a reviewer.
 */
const PLUGGY_TOP_LEVEL_IDS = [
  "01000000",
  "02000000",
  "03000000",
  "04000000",
  "05000000",
  "06000000",
  "07000000",
  "08000000",
  "09000000",
  "10000000",
  "11000000",
  "12000000",
  "13000000",
  "14000000",
  "15000000",
  "16000000",
  "17000000",
  "18000000",
  "19000000",
  "20000000",
  "21000000",
  "99999999",
];

const LABEL_SPOT_CHECKS = [
  { id: "01000000", en: "Income", pt: "Renda" },
  { id: "10000000", en: "Groceries", pt: "Supermercado" },
  { id: "11000000", en: "Food and drinks", pt: "Alimentos e bebidas" },
  { id: "20000000", en: "Insurance", pt: "Seguros" },
  { id: "99999999", en: "Other", pt: "Outros" },
];

describe("the closed category list", () => {
  it("holds exactly Pluggy's 22 top-level categories", () => {
    assert.deepEqual([...CATEGORY_IDS].sort(), [...PLUGGY_TOP_LEVEL_IDS].sort());
  });

  it("names every id exactly once", () => {
    assert.equal(new Set(CATEGORY_IDS).size, CATEGORY_IDS.length);
    assert.equal(Object.keys(CATEGORIES).length, CATEGORY_IDS.length);
  });

  it("carries both labels for every category", () => {
    for (const category of Object.values(CATEGORIES)) {
      assert.match(category.id, /^\d{8}$/, `${category.en}: unexpected id shape`);
      assert.ok(category.en.length > 0, `${category.id}: empty English label`);
      assert.ok(category.pt.length > 0, `${category.id}: empty Portuguese label`);
    }
  });

  it("keeps the labels distinct in both languages", () => {
    const all = Object.values(CATEGORIES);
    assert.equal(new Set(all.map((category) => category.en)).size, all.length);
    assert.equal(new Set(all.map((category) => category.pt)).size, all.length);
  });

  for (const expected of LABEL_SPOT_CHECKS) {
    it(`labels ${expected.id} as ${expected.en} / ${expected.pt}`, () => {
      const found = categoryById(expected.id);

      assert.ok(found, `${expected.id} is missing from the closed list`);
      assert.equal(found.en, expected.en);
      assert.equal(found.pt, expected.pt);
    });
  }

  it("reports absence for an id outside the list", () => {
    assert.equal(categoryById("200100000"), undefined);
    assert.equal(categoryById("22000000"), undefined);
  });
});

describe("isCategoryId", () => {
  const REJECTED = [
    "",
    " ",
    "alimentacao",
    "alimentação",
    "Food and drinks",
    "Renda",
    "1000000",
    "010000000",
    "200100000",
    "22000000",
    "99999999 ",
    "0100000O",
  ];

  it("accepts every member of the closed list", () => {
    for (const id of PLUGGY_TOP_LEVEL_IDS) {
      assert.equal(isCategoryId(id), true, `${id} should be a valid category`);
    }
  });

  for (const value of REJECTED) {
    it(`rejects ${JSON.stringify(value)}`, () => {
      assert.equal(isCategoryId(value), false);
    });
  }
});

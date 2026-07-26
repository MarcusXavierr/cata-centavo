import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CATEGORIES, isCategoryId } from "../../src/core/category.ts";
import { MCC_CATEGORIES, categoryForMcc } from "../../src/core/mcc.ts";

/** The recon run this table was derived from — see the module docblock. */
const DERIVATION = { codes: 87, transactions: 1123 };

const KNOWN = [
  { mcc: 4121, category: CATEGORIES.transportation.id },
  { mcc: 5411, category: CATEGORIES.groceries.id },
  { mcc: 5814, category: CATEGORIES.foodAndDrinks.id },
  { mcc: 5968, category: CATEGORIES.shopping.id },
  { mcc: 4722, category: CATEGORIES.travel.id },
];

/** Codes the recon run never saw, plus the shapes an unmapped lookup can arrive as. */
const UNMAPPED = [0, 1, 4900, 5817, 5960, 6011, 7995, 9999, 99999, -5814, 5814.5];

describe("the MCC table", () => {
  it("covers the codes the recon run actually saw", () => {
    assert.equal(MCC_CATEGORIES.length, DERIVATION.codes);
  });

  it("lists every code once", () => {
    const codes = MCC_CATEGORIES.map((entry) => entry.mcc);
    assert.equal(new Set(codes).size, codes.length);
  });

  it("maps only into the closed category list", () => {
    for (const entry of MCC_CATEGORIES) {
      assert.equal(isCategoryId(entry.category), true, `MCC ${entry.mcc} maps outside the closed list`);
    }
  });

  it("carries ISO 18245 codes", () => {
    for (const entry of MCC_CATEGORIES) {
      assert.equal(Number.isInteger(entry.mcc), true, `MCC ${entry.mcc} is not an integer`);
      assert.match(String(entry.mcc), /^\d{3,4}$/, `MCC ${entry.mcc} is not a 3-or-4-digit code`);
    }
  });

  it("keeps the evidence behind every mapping", () => {
    for (const entry of MCC_CATEGORIES) {
      assert.equal(Number.isInteger(entry.samples), true, `MCC ${entry.mcc}: samples is not an integer`);
      assert.equal(Number.isInteger(entry.agreeing), true, `MCC ${entry.mcc}: agreeing is not an integer`);
      assert.ok(entry.agreeing >= 1, `MCC ${entry.mcc}: no transaction backs the mapping`);
      assert.ok(entry.agreeing <= entry.samples, `MCC ${entry.mcc}: more agreement than evidence`);
    }
  });

  it("adds up to the sample the recon run reported", () => {
    const samples = MCC_CATEGORIES.reduce((total, entry) => total + entry.samples, 0);
    assert.equal(samples, DERIVATION.transactions);
  });

  it("keeps 5968 as the weakest mapping, a plurality rather than a majority", () => {
    const weakest = [...MCC_CATEGORIES].sort((a, b) => a.agreeing / a.samples - b.agreeing / b.samples)[0];

    assert.ok(weakest);
    assert.equal(weakest.mcc, 5968);
    assert.equal(weakest.agreeing, 12);
    assert.equal(weakest.samples, 25);
  });

  it("is sorted by code, so a reviewer can find a row", () => {
    const codes = MCC_CATEGORIES.map((entry) => entry.mcc);
    assert.deepEqual(codes, [...codes].sort((a, b) => a - b));
  });
});

describe("categoryForMcc", () => {
  for (const expected of KNOWN) {
    it(`maps ${expected.mcc} to ${expected.category}`, () => {
      assert.equal(categoryForMcc(expected.mcc), expected.category);
    });
  }

  for (const mcc of UNMAPPED) {
    it(`reports absence for the unmapped code ${mcc}`, () => {
      assert.equal(categoryForMcc(mcc), undefined);
    });
  }

  it("answers for every code in the table", () => {
    for (const entry of MCC_CATEGORIES) {
      assert.equal(categoryForMcc(entry.mcc), entry.category, `MCC ${entry.mcc} does not resolve to its own row`);
    }
  });
});

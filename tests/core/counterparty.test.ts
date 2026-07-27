import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { CategoryId } from "../../src/core/category.ts";
import { isCnpj, isDocument, learnCounterparties } from "../../src/core/counterparty.ts";

describe("counterparty document validation", () => {
  const DOCUMENT_CASES: readonly { readonly name: string; readonly value: string; readonly valid: boolean; readonly learnable: boolean }[] = [
    { name: "a CNPJ is valid and learnable", value: "12345678000190", valid: true, learnable: true },
    { name: "a CPF is valid but never learned", value: "12345678900", valid: true, learnable: false },
    { name: "eight digits is neither", value: "12345678", valid: false, learnable: false },
    { name: "an empty document is neither", value: "", valid: false, learnable: false },
  ];

  for (const { name, value, valid, learnable } of DOCUMENT_CASES) {
    it(name, () => {
      assert.equal(isDocument(value), valid);
      assert.equal(isCnpj(value), learnable);
    });
  }
});

describe("learnCounterparties", () => {
  const LEARNING_CASES: readonly { readonly name: string; readonly labels: readonly (string | null)[]; readonly winner: CategoryId | null }[] = [
    { name: "unanimous", labels: ["10000000", "10000000", "10000000"], winner: "10000000" as CategoryId },
    { name: "a true majority wins", labels: ["10000000", "10000000", "11000000"], winner: "10000000" as CategoryId },
    { name: "an exact tie is not broken", labels: ["10000000", "11000000"], winner: null },
    { name: "a plurality short of a majority loses", labels: ["10000000", "10000000", "11000000", "12000000", "13000000"], winner: null },
    { name: "a single sample is a majority of one", labels: ["10000000"], winner: "10000000" as CategoryId },
  ];

  for (const { name, labels, winner } of LEARNING_CASES) {
    it(name, () => {
      const doc = "12345678000190";
      const rows = labels.map((category) => ({ document: doc, category }));
      const learned = learnCounterparties(rows);
      if (winner === null) {
        assert.equal(learned.length, 0);
      } else {
        assert.equal(learned.length, 1);
        assert.equal(learned[0]?.document, doc);
        assert.equal(learned[0]?.category, winner);
        assert.equal(learned[0]?.samples, labels.filter(Boolean).length);
      }
    });
  }

  it("ignores CPF rows completely", () => {
    const cpf = "12345678900";
    const rows = [{ document: cpf, category: "10000000" }];
    assert.deepEqual(learnCounterparties(rows), []);
  });

  it("ignores rows with no category", () => {
    const cnpj = "12345678000190";
    const rows = [
      { document: cnpj, category: null },
      { document: cnpj, category: "10000000" },
    ];
    const learned = learnCounterparties(rows);
    assert.equal(learned.length, 1);
    assert.equal(learned[0]?.samples, 1);
    assert.equal(learned[0]?.agreeing, 1);
  });
});

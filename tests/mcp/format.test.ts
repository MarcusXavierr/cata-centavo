import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { prune, toDecimal } from "../../src/mcp/format.ts";

describe("toDecimal", () => {
  const money = [
    { cents: 0, text: "0.00", why: "zero is a real number and must survive" },
    { cents: 5, text: "0.05" },
    { cents: 150000, text: "1500.00" },
    { cents: 123456, text: "1234.56" },
    { cents: -80025, text: "-800.25" },
  ];

  for (const { cents, text, why } of money) {
    let suffix = "";
    if (why !== undefined) {
      suffix = `: ${why}`;
    }

    it(`formats ${cents} cents as ${text}${suffix}`, () => {
      assert.equal(toDecimal(cents), text);
    });
  }
});

describe("prune", () => {
  const pruning = [
    { input: { a: null }, output: {}, why: "null is dropped" },
    { input: { a: undefined }, output: {}, why: "undefined is dropped" },
    { input: { a: 0 }, output: { a: 0 }, why: "zero survives — a zero balance is not absence" },
    { input: { a: "" }, output: { a: "" }, why: "empty string survives" },
    { input: { a: false }, output: { a: false }, why: "false survives" },
    { input: { a: { b: null, c: 1 } }, output: { a: { c: 1 } }, why: "nested" },
    { input: [null, 0, undefined, false], output: [0, false], why: "arrays omit only absent values" },
  ];

  for (const { input, output, why } of pruning) {
    it(why, () => {
      assert.deepEqual(prune(input), output);
    });
  }
});

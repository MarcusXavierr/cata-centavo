import assert from "node:assert/strict";
import { test } from "node:test";

import { normalizeDescription } from "../../src/core/description.ts";

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

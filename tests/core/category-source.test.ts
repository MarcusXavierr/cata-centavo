import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  resolveCategory,
  type CategorySource,
  type DerivedColumns,
} from "../../src/core/category-source.ts";

const ALL: DerivedColumns = {
  override: "01000000",
  counterparty: "02000000",
  pluggy: "03000000",
  snapshot: "04000000",
  learned: "05000000",
  mcc: "06000000",
};

const PRECEDENCE_CASES: readonly {
  readonly name: string;
  readonly columns: DerivedColumns;
  readonly category: string | null;
  readonly source: CategorySource | null;
}[] = [
  { name: "an override beats everything", columns: ALL, category: "01000000", source: "override" },
  { name: "a manual counterparty beats Pluggy", columns: { ...ALL, override: null }, category: "02000000", source: "counterparty" },
  { name: "live Pluggy beats the harvest", columns: { ...ALL, override: null, counterparty: null }, category: "03000000", source: "pluggy" },
  { name: "the snapshot answers once live Pluggy goes quiet", columns: { ...ALL, override: null, counterparty: null, pluggy: null }, category: "04000000", source: "pluggy" },
  { name: "a learned counterparty beats the MCC", columns: { override: null, counterparty: null, pluggy: null, snapshot: null, learned: "05000000", mcc: "06000000" }, category: "05000000", source: "learned" },
  { name: "the MCC is the last resort", columns: { override: null, counterparty: null, pluggy: null, snapshot: null, learned: null, mcc: "06000000" }, category: "06000000", source: "mcc" },
  { name: "nothing matched", columns: { override: null, counterparty: null, pluggy: null, snapshot: null, learned: null, mcc: null }, category: null, source: null },
];

describe("resolveCategory", () => {
  for (const { name, columns, category, source } of PRECEDENCE_CASES) {
    it(name, () => {
      assert.deepEqual(resolveCategory(columns), { category, categorySrc: source });
    });
  }
});

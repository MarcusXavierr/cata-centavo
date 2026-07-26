import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { collectAccounts } from "../../src/core/accounts.ts";
import type { BankFailure } from "../../src/core/contracts.ts";
import { AuthError } from "../../src/pluggy/errors.ts";
import { fakeBank, threeConnections } from "../fakes/fake-bank.ts";

function toFailure(error: unknown): BankFailure {
  assert.ok(error instanceof Error);

  let kind: BankFailure["kind"];
  if (error instanceof AuthError) {
    kind = "auth";
  } else {
    kind = "unavailable";
  }

  return { kind, message: error.message };
}

describe("collectAccounts", () => {
  const cases: readonly {
    readonly why: string;
    readonly broken?: Readonly<Record<string, Error>>;
    readonly empty?: readonly string[];
    readonly expectAccounts: number;
    readonly expectUnavailable: readonly {
      readonly connectionId: string;
      readonly kind: BankFailure["kind"];
    }[];
  }[] = [
    {
      why: "returns every account when every connection answers",
      expectAccounts: 6,
      expectUnavailable: [],
    },
    {
      why: "returns what it has and names what failed",
      broken: { "conn-2": new AuthError("refused", 401) },
      expectAccounts: 4,
      expectUnavailable: [{ connectionId: "conn-2", kind: "auth" }],
    },
    {
      why: "names every connection when none answer",
      broken: {
        "conn-1": new AuthError("refused", 401),
        "conn-2": new AuthError("refused", 401),
        "conn-3": new AuthError("refused", 401),
      },
      expectAccounts: 0,
      expectUnavailable: [
        { connectionId: "conn-1", kind: "auth" },
        { connectionId: "conn-2", kind: "auth" },
        { connectionId: "conn-3", kind: "auth" },
      ],
    },
    {
      why: "treats a connection with no accounts as unavailable",
      empty: ["conn-2"],
      expectAccounts: 4,
      expectUnavailable: [{ connectionId: "conn-2", kind: "no-accounts" }],
    },
  ];

  for (const { why, broken, empty, expectAccounts, expectUnavailable } of cases) {
    it(why, async () => {
      const fixture = threeConnections();
      const accounts = { ...fixture.accounts };

      for (const connectionId of empty ?? []) {
        accounts[connectionId] = [];
      }

      let unreachableField: { unreachable: Readonly<Record<string, Error>> } | Record<string, never>;
      if (broken === undefined) {
        unreachableField = {};
      } else {
        unreachableField = { unreachable: broken };
      }

      const bank = fakeBank({
        ...fixture,
        accounts,
        ...unreachableField,
      });
      const result = await collectAccounts(bank, fixture.connections.map(({ id }) => id), toFailure);

      assert.equal(result.accounts.length, expectAccounts);
      assert.deepEqual(
        result.unavailable.map(({ connectionId, kind }) => ({ connectionId, kind })),
        expectUnavailable,
      );
    });
  }

  it("explains why an empty connection is unavailable", async () => {
    const fixture = threeConnections();
    const result = await collectAccounts(
      fakeBank({ ...fixture, accounts: { ...fixture.accounts, "conn-2": [] } }),
      fixture.connections.map(({ id }) => id),
      toFailure,
    );

    assert.match(result.unavailable[0]?.message ?? "", /conn-2.*no accounts.*revoked consent/i);
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Account } from "../../src/core/account.ts";
import { createPluggyClient } from "../../src/pluggy/client.ts";
import { RATE_LIMIT_RETRIES, type RateLimiter } from "../../src/pluggy/transport.ts";
import {
  AuthError,
  HttpError,
  NotFoundError,
  PluggyError,
  RateLimitError,
  ResponseShapeError,
  toFailure,
} from "../../src/pluggy/errors.ts";
import { fakeFetch, fakeJwt, json, type FakeFetch, type Handler } from "../fakes/fake-fetch.ts";
import { fixedClock, type FixedClock } from "../fakes/fixed-clock.ts";
import { fakeLogger } from "../fakes/fake-logger.ts";

const NOW = new Date("2026-07-25T12:00:00.000Z");
const ID = "aaaaaaaa-1111-2222-3333-444444444444";
const OTHER_ID = "bbbbbbbb-1111-2222-3333-444444444444";
const KEY_LIFETIME_MS = 2 * 60 * 60 * 1000;

const CREDENTIALS = { clientId: "client-id", clientSecret: "client-secret" };
const BASE_URL = "https://api.test";

function itemBody(id: string, overrides: Record<string, unknown> = {}): unknown {
  return {
    id,
    connector: { id: 200, name: "Nubank" },
    status: "UPDATED",
    executionStatus: "SUCCESS",
    lastUpdatedAt: "2026-07-25T09:00:00.000Z",
    consecutiveFailedLoginAttempts: 0,
    ...overrides,
  };
}

function accountBody(id: string, itemId = ID): unknown {
  return {
    id,
    itemId,
    type: "BANK",
    subtype: "CHECKING_ACCOUNT",
    name: `Account ${id}`,
    marketingName: null,
    balance: 123.45,
    currencyCode: "BRL",
    creditData: null,
  };
}

function accountPage(page: number, totalPages: number, results: readonly unknown[]): unknown {
  return { total: results.length * totalPages, totalPages, page, results };
}

function isAuth(request: { url: string }): boolean {
  return request.url.endsWith("/auth");
}

const TRANSACTION_ACCOUNT: Account = {
  id: "acc-card",
  connectionId: ID,
  institution: "Nubank",
  name: "Card",
  type: "CREDIT",
  subtype: "CREDIT_CARD",
  amountCents: 0,
  currency: "BRL",
  lastUpdatedAt: NOW,
  credit: null,
};

type TransactionPageCase = { readonly ids: readonly string[]; readonly next: string | null };

function transactionBody(id: string, accountId = TRANSACTION_ACCOUNT.id): unknown {
  return {
    id,
    accountId,
    date: "2026-06-20T03:00:00.000Z",
    description: `Transaction ${id}`,
    amount: 10,
    amountInAccountCurrency: null,
    currencyCode: "BRL",
    categoryId: "01000000",
    creditCardMetadata: null,
    paymentData: null,
  };
}

type PageResponder = Handler & { readonly urls: readonly string[] };

function pageResponder(pages: readonly TransactionPageCase[]): PageResponder {
  const urls: string[] = [];
  let pageIndex = 0;
  const responder: Handler = (request) => {
    if (isAuth(request)) {
      return json({ apiKey: fakeJwt(new Date(NOW.getTime() + KEY_LIFETIME_MS)) });
    }

    urls.push(request.url);
    const page = pages[pageIndex];
    assert.ok(page, `missing synthetic page ${pageIndex}`);
    pageIndex += 1;
    return json({ results: page.ids.map((id) => transactionBody(id)), next: page.next });
  };

  return Object.assign(responder, { urls });
}

function endlessPageResponder(): Handler {
  let pageIndex = 0;
  return (request) => {
    if (isAuth(request)) {
      return json({ apiKey: fakeJwt(new Date(NOW.getTime() + KEY_LIFETIME_MS)) });
    }

    const id = `transaction-${pageIndex}`;
    pageIndex += 1;
    return json({ results: [transactionBody(id)], next: `?after=${pageIndex}` });
  };
}

function categoryResponder(): Handler {
  return (request) => {
    if (isAuth(request)) {
      return json({ apiKey: fakeJwt(new Date(NOW.getTime() + KEY_LIFETIME_MS)) });
    }

    return json({
      results: [{ id: "01000000", description: "Income", parentId: null }],
      total: 1,
      totalPages: 1,
      page: 1,
    });
  };
}

function failingThenWorkingCategories(): Handler {
  let categoryCalls = 0;
  return (request) => {
    if (isAuth(request)) {
      return json({ apiKey: fakeJwt(new Date(NOW.getTime() + KEY_LIFETIME_MS)) });
    }

    categoryCalls += 1;
    if (categoryCalls === 1) {
      return json({ message: "temporarily unavailable" }, 503);
    }

    return json({
      results: [{ id: "01000000", description: "Income", parentId: null }],
      total: 1,
      totalPages: 1,
      page: 1,
    });
  };
}

type Harness = {
  readonly client: ReturnType<typeof createPluggyClient>;
  readonly fetch: FakeFetch;
  readonly clock: FixedClock;
  readonly slept: readonly number[];
  readonly log: ReturnType<typeof fakeLogger>;
  authCount(): number;
};

/**
 * `sleep` is injected in every harness, never defaulted. The 429 backoff waits a
 * documented minute, and one test forgetting to replace it is two minutes of a
 * suite that looks hung rather than failed.
 */
type HarnessOptions = { readonly responder?: Handler; readonly limiter?: RateLimiter };
type HarnessArgument = Handler | HarnessOptions;

function harness(argument?: HarnessArgument): Harness {
  const clock = fixedClock(NOW);
  const slept: number[] = [];

  let responder: Handler | undefined;
  let limiter: RateLimiter | undefined;
  if (typeof argument === "function") {
    responder = argument;
  } else {
    responder = argument?.responder;
    limiter = argument?.limiter;
  }

  const fetch = fakeFetch(
    responder ??
      ((request) => {
        if (isAuth(request)) {
          return json({ apiKey: fakeJwt(new Date(clock.now().getTime() + KEY_LIFETIME_MS)) });
        }
        return json(itemBody(ID));
      }),
  );
  const log = fakeLogger();

  const clientOptions = {
    credentials: CREDENTIALS,
    clock,
    fetch,
    baseUrl: BASE_URL,
    sleep: async (milliseconds: number) => {
      slept.push(milliseconds);
    },
    log,
  };
  if (limiter !== undefined) {
    Object.assign(clientOptions, { limiter });
  }
  const client = createPluggyClient(clientOptions);

  return {
    client,
    fetch,
    clock,
    slept,
    log,
    authCount: () => fetch.requests.filter(isAuth).length,
  };
}

describe("createPluggyClient", () => {
  const WALK_CASES: readonly {
    readonly name: string;
    readonly pages: readonly TransactionPageCase[];
    readonly expected: number;
  }[] = [
    { name: "a single page", pages: [{ ids: ["a"], next: null }], expected: 1 },
    {
      name: "three pages",
      pages: [{ ids: ["a"], next: "?after=1" }, { ids: ["b"], next: "?after=2" }, { ids: ["c"], next: null }],
      expected: 3,
    },
    { name: "a short page that is not the last", pages: [{ ids: ["a"], next: "?after=1" }, { ids: ["b", "c"], next: null }], expected: 3 },
    { name: "an account with no transactions", pages: [{ ids: [], next: null }], expected: 0 },
  ];

  for (const { name, pages, expected } of WALK_CASES) {
    it(`the walk terminates only on next === null: ${name}`, async () => {
      const { client } = harness({ responder: pageResponder(pages), limiter: { acquire: async () => {} } });

      assert.equal((await client.getTransactions(TRANSACTION_ACCOUNT)).length, expected);
    });
  }

  it("the walk joins next as a query string, not a path", async () => {
    const responder = pageResponder([{ ids: ["a"], next: "?after=abc" }, { ids: ["b"], next: null }]);
    const { client } = harness({ responder, limiter: { acquire: async () => {} } });

    await client.getTransactions(TRANSACTION_ACCOUNT);

    assert.equal(responder.urls[1], `${BASE_URL}/v2/transactions?after=abc`);
  });

  it("the walk fails when the cursor stops advancing", async () => {
    const { client } = harness({
      responder: pageResponder([{ ids: ["a"], next: "?after=1" }, { ids: ["b"], next: "?after=1" }]),
      limiter: { acquire: async () => {} },
    });

    await assert.rejects(() => client.getTransactions(TRANSACTION_ACCOUNT), /cursor/iu);
  });

  it("the walk fails when a page repeats ids already seen", async () => {
    const { client } = harness({
      responder: pageResponder([{ ids: ["a"], next: "?after=1" }, { ids: ["a"], next: "?after=2" }]),
      limiter: { acquire: async () => {} },
    });

    await assert.rejects(() => client.getTransactions(TRANSACTION_ACCOUNT), /already seen/iu);
  });

  it("the walk fails loudly on the hop cap instead of looping forever", async () => {
    const { client } = harness({ responder: endlessPageResponder(), limiter: { acquire: async () => {} } });

    await assert.rejects(() => client.getTransactions(TRANSACTION_ACCOUNT), /500/u);
  });

  it("getCategories is fetched once per client and reused", async () => {
    const { client, fetch } = harness({ responder: categoryResponder(), limiter: { acquire: async () => {} } });

    await client.getCategories();
    await client.getCategories();

    assert.equal(fetch.requests.filter((request) => request.url.includes("/categories")).length, 1);
  });

  it("a failed getCategories is not cached", async () => {
    const { client } = harness({ responder: failingThenWorkingCategories(), limiter: { acquire: async () => {} } });

    await assert.rejects(() => client.getCategories());
    assert.equal((await client.getCategories()).length, 1);
  });

  it("performs no I/O when constructed", () => {
    const { fetch } = harness();
    assert.equal(fetch.requests.length, 0);
  });

  it("authenticates, then sends the key on the item request", async () => {
    const { client, fetch } = harness();

    const connection = await client.getConnection(ID);

    const [auth, item] = fetch.requests;
    assert.equal(auth?.method, "POST");
    assert.equal(auth?.url, `${BASE_URL}/auth`);
    assert.equal(auth?.contentType, "application/json");
    assert.deepEqual(auth?.body, { clientId: "client-id", clientSecret: "client-secret" });
    assert.equal(auth?.apiKey, null, "credentials must not be sent as an API key");

    assert.equal(item?.method, "GET");
    assert.equal(item?.url, `${BASE_URL}/items/${ID}`);
    assert.match(item?.apiKey ?? "", /^ey/);

    assert.deepEqual(connection, {
      id: ID,
      institution: "Nubank",
      status: "UPDATED",
      executionStatus: "SUCCESS",
      lastUpdatedAt: new Date("2026-07-25T09:00:00.000Z"),
      parameter: null,
      warnings: [],
    });
  });

  it("keeps a null lastUpdatedAt null instead of inventing a date", async () => {
    const { client } = harness((request) => {
      if (isAuth(request)) {
        return json({ apiKey: fakeJwt(new Date(NOW.getTime() + KEY_LIFETIME_MS)) });
      }
      return json(itemBody(ID, { lastUpdatedAt: null }));
    });

    assert.equal((await client.getConnection(ID)).lastUpdatedAt, null);
  });

  it("follows every page to the reported totalPages", async () => {
    const { client, fetch } = harness((request) => {
      if (isAuth(request)) {
        return json({ apiKey: fakeJwt(new Date(NOW.getTime() + KEY_LIFETIME_MS)) });
      }

      const url = new URL(request.url);
      if (url.pathname === "/items/" + ID) {
        return json(itemBody(ID));
      }

      const page = url.searchParams.get("page");
      return json(accountPage(Number(page), 2, [accountBody(`account-${page}`)]));
    });

    const accounts = await client.getAccounts(ID);

    assert.deepEqual(
      accounts.map((account) => account.id),
      ["account-1", "account-2"],
    );
    const accountRequests = fetch.requests.filter((request) => new URL(request.url).pathname === "/accounts");
    assert.equal(accountRequests.length, 2);
    assert.deepEqual(
      accountRequests.map((request) => new URL(request.url).searchParams.get("pageSize")),
      ["500", "500"],
    );
  });

  it("asks for the item as well as the accounts", async () => {
    const { client, fetch } = harness((request) => {
      if (isAuth(request)) {
        return json({ apiKey: fakeJwt(new Date(NOW.getTime() + KEY_LIFETIME_MS)) });
      }

      if (new URL(request.url).pathname === "/items/" + ID) {
        return json(itemBody(ID));
      }
      return json(accountPage(1, 1, [accountBody("account-1")]));
    });

    await client.getAccounts(ID);

    const item = fetch.requests.find((request) => new URL(request.url).pathname === "/items/" + ID);
    const accounts = fetch.requests.find((request) => new URL(request.url).pathname === "/accounts");
    assert.ok(item);
    assert.equal(new URL(accounts?.url ?? "").searchParams.get("itemId"), ID);
  });

  it("puts the requested account id in the path", async () => {
    const { client, fetch } = harness((request) => {
      if (isAuth(request)) {
        return json({ apiKey: fakeJwt(new Date(NOW.getTime() + KEY_LIFETIME_MS)) });
      }

      if (new URL(request.url).pathname === "/accounts/acc-1") {
        return json(accountBody("acc-1"));
      }
      return json(itemBody(ID));
    });

    await client.getAccount("acc-1");

    const read = fetch.requests.find((request) => request.url.includes("/accounts/"));
    const owner = fetch.requests.find((request) => request.url.includes("/items/"));
    assert.match(read?.url ?? "", /\/accounts\/acc-1(\?|$)/);
    assert.match(owner?.url ?? "", new RegExp(`/items/${ID}$`));
  });

  it("reuses the cached key across requests", async () => {
    const { client, authCount } = harness();

    await client.getConnection(ID);
    await client.getConnection(OTHER_ID);

    assert.equal(authCount(), 1);
  });

  it("renews the key at the margin, not at its expiry", async () => {
    const { client, clock, authCount } = harness();

    await client.getConnection(ID);
    assert.equal(authCount(), 1);

    clock.advance(KEY_LIFETIME_MS - 10 * 60 * 1000 - 60_000);
    await client.getConnection(ID);
    assert.equal(authCount(), 1, "renewed before the margin was reached");

    clock.advance(60_000);
    await client.getConnection(ID);
    assert.equal(authCount(), 2, "still using a key at the renewal margin");
  });

  /**
   * Found by mutation testing: `now + KEY_FALLBACK_LIFETIME_MS` could be flipped
   * to `now -` with the whole suite still green. A key Pluggy hands us that is
   * not a JWT would then be born expired, and the client would re-authenticate
   * on every single request instead of once.
   */
  it("falls back to a future expiry for a key with no exp claim, not a past one", async () => {
    const { client, authCount } = harness((request) => {
      if (isAuth(request)) {
        return json({ apiKey: "opaque-key-that-is-not-a-jwt" });
      }
      return json(itemBody(ID));
    });

    await client.getConnection(ID);
    await client.getConnection(OTHER_ID);

    assert.equal(authCount(), 1, "re-authenticated for every request, so the fallback expiry is in the past");
  });

  it("uses a JWT expiry that is shorter than the fallback lifetime", async () => {
    const expiresAt = new Date(NOW.getTime() + 45 * 60 * 1000);
    const { client, clock, authCount } = harness((request) => {
      if (isAuth(request)) {
        return json({ apiKey: fakeJwt(expiresAt) });
      }
      return json(itemBody(ID));
    });

    await client.getConnection(ID);
    clock.advance(35 * 60 * 1000);
    await client.getConnection(ID);

    assert.equal(authCount(), 2, "ignored the JWT expiry and used the fallback lifetime");
  });

  it("issues one POST /auth for concurrent cold requests", async () => {
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const clock = fixedClock(NOW);
    const fetch = fakeFetch(async (request) => {
      if (isAuth(request)) {
        await gate;
        return json({ apiKey: fakeJwt(new Date(NOW.getTime() + KEY_LIFETIME_MS)) });
      }
      return json(itemBody(request.url.split("/").pop() ?? ID));
    });

    const client = createPluggyClient({ credentials: CREDENTIALS, clock, fetch, baseUrl: BASE_URL, log: fakeLogger() });

    const pending = Promise.all([
      client.getConnection(ID),
      client.getConnection(OTHER_ID),
      client.getConnection(ID),
    ]);
    release();
    await pending;

    assert.equal(fetch.requests.filter(isAuth).length, 1);
  });

  it("forces one refresh and one retry on a 401, then gives up", async () => {
    const { client, fetch, authCount } = harness((request, index) => {
      if (isAuth(request)) {
        return json({ apiKey: fakeJwt(new Date(NOW.getTime() + KEY_LIFETIME_MS)) });
      }
      if (index === 1) {
        return json({ message: "expired" }, 401);
      }
      return json(itemBody(ID));
    });

    await client.getConnection(ID);

    assert.equal(authCount(), 2, "the 401 did not force a refresh");
    assert.equal(fetch.requests.filter((request) => !isAuth(request)).length, 2);
  });

  it("fails with AuthError when the retried request is refused again", async () => {
    const { client, fetch } = harness((request) => {
      if (isAuth(request)) {
        return json({ apiKey: fakeJwt(new Date(NOW.getTime() + KEY_LIFETIME_MS)) });
      }
      return json({ message: "nope" }, 401);
    });

    await assert.rejects(client.getConnection(ID), AuthError);
    assert.equal(fetch.requests.filter((request) => !isAuth(request)).length, 2, "retried more than once");
  });

  it("reports refused credentials as an AuthError without retrying forever", async () => {
    const { client, authCount } = harness((request) => {
      if (isAuth(request)) {
        return json({ message: "bad credentials" }, 401);
      }
      return json(itemBody(ID));
    });

    await assert.rejects(
      client.verifyCredentials(),
      (error: unknown) => error instanceof AuthError && /authenticating.*PLUGGY_CLIENT_ID/.test(error.message),
    );
    assert.equal(authCount(), 1);
  });

  it("names a malformed auth response", async () => {
    const { client } = harness((request) => {
      if (isAuth(request)) {
        return json({ apiKey: null });
      }
      return json(itemBody(ID));
    });

    await assert.rejects(
      client.verifyCredentials(),
      (error: unknown) => error instanceof ResponseShapeError && /the \/auth response did not match/.test(error.message),
    );
  });

  it("maps the status codes onto distinguishable errors", async () => {
    const cases = [
      { status: 401, expected: AuthError, kind: "auth", message: /PLUGGY_CLIENT_ID/ },
      { status: 403, expected: AuthError, kind: "auth", message: /PLUGGY_CLIENT_ID/ },
      { status: 404, expected: NotFoundError, kind: "unknown-connection", message: /wrong id/ },
      { status: 429, expected: RateLimitError, kind: "rate-limited", message: new RegExp(`connection ${ID}`) },
      {
        status: 500,
        expected: HttpError,
        kind: "unavailable",
        message: new RegExp(`Pluggy returned 500 while connection ${ID} — no`),
      },
    ];

    for (const { status, expected, kind, message } of cases) {
      const { client } = harness((request) => {
        if (isAuth(request)) {
          return json({ apiKey: fakeJwt(new Date(NOW.getTime() + KEY_LIFETIME_MS)) });
        }
        return json({ message: "no" }, status);
      });

      await assert.rejects(
        client.getConnection(ID),
        (error: unknown) => {
          if (!(error instanceof expected) || error.kind !== kind) return false;
          assert.match(error.message, message);
          return true;
        },
        `status ${status}`,
      );
    }
  });

  it("identifies the failed endpoint in account lookups", async () => {
    const cases: readonly {
      readonly why: string;
      readonly request: (client: ReturnType<typeof createPluggyClient>) => Promise<unknown>;
      readonly response: Handler;
      readonly message: RegExp;
    }[] = [
      {
        why: "the connection read before an account list",
        request: (client) => client.getAccounts(ID),
        response: (request) => {
          if (request.url.endsWith(`/items/${ID}`)) {
            return json({ message: "unavailable" }, 500);
          }
          return json(accountPage(1, 1, []));
        },
        message: new RegExp(`connection ${ID}`),
      },
      {
        why: "the first account-list page",
        request: (client) => client.getAccounts(ID),
        response: (request) => {
          if (request.url.endsWith(`/items/${ID}`)) {
            return json(itemBody(ID));
          }
          return json({ message: "unavailable" }, 500);
        },
        message: new RegExp(`accounts ${ID}`),
      },
      {
        why: "a later account-list page",
        request: (client) => client.getAccounts(ID),
        response: (request) => {
          if (request.url.endsWith(`/items/${ID}`)) return json(itemBody(ID));
          if (request.url.includes("page=1")) return json(accountPage(1, 2, [accountBody("first")]));
          return json({ message: "unavailable" }, 500);
        },
        message: new RegExp(`accounts ${ID}`),
      },
      {
        why: "an account read",
        request: (client) => client.getAccount("account-1"),
        response: () => json({ message: "unavailable" }, 500),
        message: /account account-1/,
      },
      {
        why: "the account owner's connection read",
        request: (client) => client.getAccount("account-1"),
        response: (request) => {
          if (request.url.endsWith("/accounts/account-1")) {
            return json(accountBody("account-1"));
          }
          return json({ message: "unavailable" }, 500);
        },
        message: new RegExp(`connection ${ID}`),
      },
    ];

    for (const { why, request, response, message } of cases) {
      const { client } = harness((fetchRequest, index) => {
        if (isAuth(fetchRequest)) {
          return json({ apiKey: fakeJwt(new Date(NOW.getTime() + KEY_LIFETIME_MS)) });
        }
        return response(fetchRequest, index);
      });

      await assert.rejects(request(client), (error: Error) => {
        assert.match(error.message, message, why);
        return true;
      });
    }
  });

  it("preserves a Pluggy failure's kind and message", () => {
    const error = new PluggyError("Pluggy is unavailable", "unavailable", 503);

    assert.deepEqual(toFailure(error), { kind: "unavailable", message: "Pluggy is unavailable" });
  });

  it("turns an unknown failure into an unavailable failure", () => {
    const error = new Error("network interrupted");

    assert.deepEqual(toFailure(error), { kind: "unavailable", message: String(error) });
  });

  it("waits out a 429 on a read too, since both paths share the send function", async () => {
    const { client, slept, fetch, log } = harness((request) => {
      if (isAuth(request)) {
        return json({ apiKey: fakeJwt(new Date(NOW.getTime() + KEY_LIFETIME_MS)) });
      }
      return json({ message: "slow down" }, 429, { "retry-after": "3" });
    });

    await assert.rejects(client.getConnection(ID), RateLimitError);

    assert.deepEqual(slept, Array.from({ length: RATE_LIMIT_RETRIES }, () => 3_000));
    assert.equal(fetch.requests.filter((request) => !isAuth(request)).length, RATE_LIMIT_RETRIES + 1);
    assert.ok(fetch.requests.filter((request) => !isAuth(request)).every((request) => request.apiKey !== null));
    assert.deepEqual(
      log.lines.filter((line) => line.level === "warn"),
      Array.from({ length: RATE_LIMIT_RETRIES }, (_, index) => ({
        level: "warn",
        fields: {
          method: "GET",
          path: `/items/${ID}`,
          attempt: index + 1,
          maxRetries: RATE_LIMIT_RETRIES,
        },
        message: "rate limit response; retrying",
      })),
    );
    assert.doesNotMatch(JSON.stringify(log.lines), /client-secret/);
  });

  it("rejects a 200 whose body is not the shape we expect", async () => {
    const { client } = harness((request) => {
      if (isAuth(request)) {
        return json({ apiKey: fakeJwt(new Date(NOW.getTime() + KEY_LIFETIME_MS)) });
      }
      return json({ id: ID, connector: "Nubank" });
    });

    await assert.rejects(
      client.getConnection(ID),
      (error: unknown) =>
        error instanceof ResponseShapeError &&
        error.kind === "bad-response" &&
        /connection .* did not match the shape we expect, at: connector/.test(error.message),
    );
  });

  it("rejects a successful response that is not JSON", async () => {
    const { client } = harness((request) => {
      if (isAuth(request)) {
        return json({ apiKey: fakeJwt(new Date(NOW.getTime() + KEY_LIFETIME_MS)) });
      }
      return new Response("<html>gateway</html>", { status: 200 });
    });

    await assert.rejects(
      client.getConnection(ID),
      (error: unknown) => error instanceof ResponseShapeError && /body that is not JSON/.test(error.message),
    );
  });

  it("names every malformed field in a successful item response", async () => {
    const { client } = harness((request) => {
      if (isAuth(request)) {
        return json({ apiKey: fakeJwt(new Date(NOW.getTime() + KEY_LIFETIME_MS)) });
      }
      return json(itemBody(ID, { connector: {}, parameter: {} }));
    });

    await assert.rejects(client.getConnection(ID), (error: Error) => {
      assert.equal(
        error.message,
        `connection ${ID} did not match the shape we expect, at: connector.name, parameter.name, parameter.label`,
      );
      return true;
    });
  });

  it("names a root-level item response mismatch", async () => {
    const { client } = harness((request) => {
      if (isAuth(request)) {
        return json({ apiKey: fakeJwt(new Date(NOW.getTime() + KEY_LIFETIME_MS)) });
      }
      return json(null);
    });

    await assert.rejects(client.getConnection(ID), (error: Error) => {
      assert.equal(error.message, `connection ${ID} did not match the shape we expect, at: (root)`);
      return true;
    });
  });

  it("passes every request through the limiter, auth included", async () => {
    const clock = fixedClock(NOW);
    const acquired: number[] = [];
    const fetch = fakeFetch((request) => {
      if (isAuth(request)) {
        return json({ apiKey: fakeJwt(new Date(NOW.getTime() + KEY_LIFETIME_MS)) });
      }
      return json(itemBody(ID));
    });

    const client = createPluggyClient({
      credentials: CREDENTIALS,
      clock,
      fetch,
      baseUrl: BASE_URL,
      limiter: {
        acquire: async () => {
          acquired.push(acquired.length);
        },
      },
      log: fakeLogger(),
    });

    await client.getConnection(ID);

    assert.equal(acquired.length, fetch.requests.length);
    assert.equal(acquired.length, 2);
  });

  it("reads the MFA prompt's label out of the item", async () => {
    const { client } = harness((request) => {
      if (isAuth(request)) {
        return json({ apiKey: fakeJwt(new Date(NOW.getTime() + KEY_LIFETIME_MS)) });
      }
      return json(
        itemBody(ID, {
          status: "WAITING_USER_INPUT",
          executionStatus: "WAITING_USER_INPUT",
          parameter: { name: "token", label: "Chave de segurança", type: "string" },
        }),
      );
    });

    assert.equal((await client.getConnection(ID)).parameter, "Chave de segurança");
  });

  it("flattens the statusDetail warnings a PARTIAL_SUCCESS carries", async () => {
    const { client } = harness((request) => {
      if (isAuth(request)) {
        return json({ apiKey: fakeJwt(new Date(NOW.getTime() + KEY_LIFETIME_MS)) });
      }
      return json(
        itemBody(ID, {
          status: "UPDATED",
          executionStatus: "PARTIAL_SUCCESS",
          statusDetail: {
            creditCards: {
              isUpdated: false,
              warnings: [{ code: "423", message: "Open Finance monthly rate limit reached" }],
            },
            accounts: { isUpdated: true, warnings: [] },
          },
        }),
      );
    });

    assert.deepEqual((await client.getConnection(ID)).warnings, [
      "creditCards: Open Finance monthly rate limit reached",
    ]);
  });

  it("ignores an advisory product without status details", async () => {
    const { client } = harness((request) => {
      if (isAuth(request)) {
        return json({ apiKey: fakeJwt(new Date(NOW.getTime() + KEY_LIFETIME_MS)) });
      }
      return json(itemBody(ID, { statusDetail: { accounts: null } }));
    });

    assert.deepEqual((await client.getConnection(ID)).warnings, []);
  });

  it("survives a statusDetail shaped in a way we did not predict", async () => {
    const { client } = harness((request) => {
      if (isAuth(request)) {
        return json({ apiKey: fakeJwt(new Date(NOW.getTime() + KEY_LIFETIME_MS)) });
      }
      return json(itemBody(ID, { statusDetail: "something else entirely" }));
    });

    const connection = await client.getConnection(ID);

    assert.equal(connection.id, ID, "an advisory field cost us a whole connection");
    assert.deepEqual(connection.warnings, []);
  });

  it("repeats Pluggy's own explanation of a 400 rather than only its number", async () => {
    const { client } = harness((request) => {
      if (isAuth(request)) {
        return json({ apiKey: fakeJwt(new Date(NOW.getTime() + KEY_LIFETIME_MS)) });
      }
      return json(
        {
          code: 400,
          codeDescription: "CONNECTOR_REQUIRED_PARAMETER_VALIDATION_ERROR",
          message: "The parameter 'token' is required to be renewed for item update.",
        },
        400,
      );
    });

    await assert.rejects(client.getConnection(ID), (error: Error) => {
      assert.equal(
        error.message,
        `Pluggy returned 400 while connection ${ID} — CONNECTOR_REQUIRED_PARAMETER_VALIDATION_ERROR: The parameter 'token' is required to be renewed for item update.`,
      );
      return true;
    });
  });

  it("carries the retry-after date out of a login-failure lockout", async () => {
    const { client } = harness((request) => {
      if (isAuth(request)) {
        return json({ apiKey: fakeJwt(new Date(NOW.getTime() + KEY_LIFETIME_MS)) });
      }
      return json(
        {
          code: 400,
          codeDescription: "TOO_MANY_CONSECUTIVE_LOGIN_FAILURES",
          message: "Too many consecutive login failures.",
          data: { canRetryAfterDate: "2026-07-26T12:15:00.000Z" },
        },
        400,
      );
    });

    await assert.rejects(client.getConnection(ID), (error: Error) => {
      assert.match(error.message, /retry after 2026-07-26T12:15:00.000Z/);
      return true;
    });
  });

  it("still says something useful when the error body is not an envelope", async () => {
    const { client } = harness((request) => {
      if (isAuth(request)) {
        return json({ apiKey: fakeJwt(new Date(NOW.getTime() + KEY_LIFETIME_MS)) });
      }
      return new Response("<html>gateway</html>", { status: 502 });
    });

    await assert.rejects(client.getConnection(ID), (error: Error) => {
      assert.equal(error.message, `Pluggy returned 502 while connection ${ID}`);
      return true;
    });
  });

  it("keeps the custom not-found message instead of Pluggy's envelope", async () => {
    const { client } = harness((request) => {
      if (isAuth(request)) {
        return json({ apiKey: fakeJwt(new Date(NOW.getTime() + KEY_LIFETIME_MS)) });
      }
      return json({ message: "wrong account" }, 404);
    });

    await assert.rejects(client.getConnection(ID), (error: Error) => {
      assert.equal(error.message, "not found — wrong id, or an id belonging to another Pluggy account");
      return true;
    });
  });

  it("omits null fields from Pluggy's unavailable-error detail", async () => {
    const cases = [
      {
        body: { codeDescription: null, message: "temporarily unavailable", data: null },
        expected: `Pluggy returned 503 while connection ${ID} — temporarily unavailable`,
      },
      {
        body: { codeDescription: null, message: null, data: { canRetryAfterDate: null } },
        expected: `Pluggy returned 503 while connection ${ID}`,
      },
    ];

    for (const { body, expected } of cases) {
      const { client } = harness((request) => {
        if (isAuth(request)) {
          return json({ apiKey: fakeJwt(new Date(NOW.getTime() + KEY_LIFETIME_MS)) });
        }
        return json(body, 503);
      });

      await assert.rejects(client.getConnection(ID), (error: Error) => {
        assert.equal(error.message, expected);
        return true;
      });
    }
  });

  it("falls back to a minute when the 429 names no delay", async () => {
    const { client, slept } = harness((request) => {
      if (isAuth(request)) {
        return json({ apiKey: fakeJwt(new Date(NOW.getTime() + KEY_LIFETIME_MS)) });
      }
      return json({ message: "slow down" }, 429);
    });

    await assert.rejects(client.getConnection(ID), RateLimitError);

    assert.deepEqual(slept, Array.from({ length: RATE_LIMIT_RETRIES }, () => 60_000));
  });

  it("falls back to a minute when the 429 names a zero delay", async () => {
    const { client, slept } = harness((request) => {
      if (isAuth(request)) {
        return json({ apiKey: fakeJwt(new Date(NOW.getTime() + KEY_LIFETIME_MS)) });
      }
      return json({ message: "slow down" }, 429, { "retry-after": "0" });
    });

    await assert.rejects(client.getConnection(ID), RateLimitError);

    assert.deepEqual(slept, Array.from({ length: RATE_LIMIT_RETRIES }, () => 60_000));
  });

  it("recovers when the retry after a 429 succeeds", async () => {
    let attempts = 0;
    const { client, slept } = harness((request) => {
      if (isAuth(request)) {
        return json({ apiKey: fakeJwt(new Date(NOW.getTime() + KEY_LIFETIME_MS)) });
      }
      attempts += 1;
      if (attempts === 1) {
        return json({ message: "slow down" }, 429, { "retry-after": "1" });
      }
      return json(itemBody(ID));
    });

    assert.equal((await client.getConnection(ID)).id, ID);
    assert.deepEqual(slept, [1_000]);
  });
});

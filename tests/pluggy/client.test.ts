import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createPluggyClient } from "../../src/pluggy/client.ts";
import { KEY_MARGIN_MS, RATE_LIMIT_RETRIES } from "../../src/pluggy/transport.ts";
import { AuthError, HttpError, NotFoundError, RateLimitError, ResponseShapeError } from "../../src/pluggy/errors.ts";
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

function isAuth(request: { url: string }): boolean {
  return request.url.endsWith("/auth");
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
function harness(handler?: Handler): Harness {
  const clock = fixedClock(NOW);
  const slept: number[] = [];

  const fetch = fakeFetch(
    handler ??
      ((request) =>
        isAuth(request)
          ? json({ apiKey: fakeJwt(new Date(clock.now().getTime() + KEY_LIFETIME_MS)) })
          : json(itemBody(ID))),
  );
  const log = fakeLogger();

  const client = createPluggyClient({
    credentials: CREDENTIALS,
    clock,
    fetch,
    baseUrl: BASE_URL,
    sleep: async (milliseconds) => {
      slept.push(milliseconds);
    },
    log,
  });

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
    const { client } = harness((request) =>
      isAuth(request)
        ? json({ apiKey: fakeJwt(new Date(NOW.getTime() + KEY_LIFETIME_MS)) })
        : json(itemBody(ID, { lastUpdatedAt: null })),
    );

    assert.equal((await client.getConnection(ID)).lastUpdatedAt, null);
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

    clock.advance(KEY_LIFETIME_MS - KEY_MARGIN_MS - 60_000);
    await client.getConnection(ID);
    assert.equal(authCount(), 1, "renewed before the margin was reached");

    clock.advance(2 * 60_000);
    await client.getConnection(ID);
    assert.equal(authCount(), 2, "still using a key inside the margin");
  });

  /**
   * Found by mutation testing: `now + KEY_FALLBACK_LIFETIME_MS` could be flipped
   * to `now -` with the whole suite still green. A key Pluggy hands us that is
   * not a JWT would then be born expired, and the client would re-authenticate
   * on every single request instead of once.
   */
  it("falls back to a future expiry for a key with no exp claim, not a past one", async () => {
    const { client, authCount } = harness((request) =>
      isAuth(request) ? json({ apiKey: "opaque-key-that-is-not-a-jwt" }) : json(itemBody(ID)),
    );

    await client.getConnection(ID);
    await client.getConnection(OTHER_ID);

    assert.equal(authCount(), 1, "re-authenticated for every request, so the fallback expiry is in the past");
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
      return index === 1 ? json({ message: "expired" }, 401) : json(itemBody(ID));
    });

    await client.getConnection(ID);

    assert.equal(authCount(), 2, "the 401 did not force a refresh");
    assert.equal(fetch.requests.filter((request) => !isAuth(request)).length, 2);
  });

  it("fails with AuthError when the retried request is refused again", async () => {
    const { client, fetch } = harness((request) =>
      isAuth(request)
        ? json({ apiKey: fakeJwt(new Date(NOW.getTime() + KEY_LIFETIME_MS)) })
        : json({ message: "nope" }, 401),
    );

    await assert.rejects(client.getConnection(ID), AuthError);
    assert.equal(fetch.requests.filter((request) => !isAuth(request)).length, 2, "retried more than once");
  });

  it("reports refused credentials as an AuthError without retrying forever", async () => {
    const { client, authCount } = harness((request) =>
      isAuth(request) ? json({ message: "bad credentials" }, 401) : json(itemBody(ID)),
    );

    await assert.rejects(client.verifyCredentials(), AuthError);
    assert.equal(authCount(), 1);
  });

  it("maps the status codes onto distinguishable errors", async () => {
    const cases = [
      { status: 404, expected: NotFoundError },
      { status: 429, expected: RateLimitError },
      { status: 500, expected: HttpError },
    ];

    for (const { status, expected } of cases) {
      const { client } = harness((request) =>
        isAuth(request)
          ? json({ apiKey: fakeJwt(new Date(NOW.getTime() + KEY_LIFETIME_MS)) })
          : json({ message: "no" }, status),
      );

      await assert.rejects(client.getConnection(ID), expected, `status ${status}`);
    }
  });

  it("waits out a 429 on a read too, since both paths share the send function", async () => {
    const { client, slept, fetch, log } = harness((request) =>
      isAuth(request)
        ? json({ apiKey: fakeJwt(new Date(NOW.getTime() + KEY_LIFETIME_MS)) })
        : json({ message: "slow down" }, 429, { "retry-after": "3" }),
    );

    await assert.rejects(client.getConnection(ID), RateLimitError);

    assert.deepEqual(slept, Array.from({ length: RATE_LIMIT_RETRIES }, () => 3_000));
    assert.equal(fetch.requests.filter((request) => !isAuth(request)).length, RATE_LIMIT_RETRIES + 1);
    assert.equal(log.lines.filter((line) => line.level === "warn").length, RATE_LIMIT_RETRIES);
    assert.doesNotMatch(JSON.stringify(log.lines), /client-secret/);
  });

  it("rejects a 200 whose body is not the shape we expect", async () => {
    const { client } = harness((request) =>
      isAuth(request)
        ? json({ apiKey: fakeJwt(new Date(NOW.getTime() + KEY_LIFETIME_MS)) })
        : json({ id: ID, connector: "Nubank" }),
    );

    await assert.rejects(client.getConnection(ID), ResponseShapeError);
  });

  it("passes every request through the limiter, auth included", async () => {
    const clock = fixedClock(NOW);
    const acquired: number[] = [];
    const fetch = fakeFetch((request) =>
      isAuth(request)
        ? json({ apiKey: fakeJwt(new Date(NOW.getTime() + KEY_LIFETIME_MS)) })
        : json(itemBody(ID)),
    );

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
    const { client } = harness((request) =>
      isAuth(request)
        ? json({ apiKey: fakeJwt(new Date(NOW.getTime() + KEY_LIFETIME_MS)) })
        : json(
            itemBody(ID, {
              status: "WAITING_USER_INPUT",
              executionStatus: "WAITING_USER_INPUT",
              parameter: { name: "token", label: "Chave de segurança", type: "string" },
            }),
          ),
    );

    assert.equal((await client.getConnection(ID)).parameter, "Chave de segurança");
  });

  it("flattens the statusDetail warnings a PARTIAL_SUCCESS carries", async () => {
    const { client } = harness((request) =>
      isAuth(request)
        ? json({ apiKey: fakeJwt(new Date(NOW.getTime() + KEY_LIFETIME_MS)) })
        : json(
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
          ),
    );

    assert.deepEqual((await client.getConnection(ID)).warnings, [
      "creditCards: Open Finance monthly rate limit reached",
    ]);
  });

  it("survives a statusDetail shaped in a way we did not predict", async () => {
    const { client } = harness((request) =>
      isAuth(request)
        ? json({ apiKey: fakeJwt(new Date(NOW.getTime() + KEY_LIFETIME_MS)) })
        : json(itemBody(ID, { statusDetail: "something else entirely" })),
    );

    const connection = await client.getConnection(ID);

    assert.equal(connection.id, ID, "an advisory field cost us a whole connection");
    assert.deepEqual(connection.warnings, []);
  });

  it("repeats Pluggy's own explanation of a 400 rather than only its number", async () => {
    const { client } = harness((request) =>
      isAuth(request)
        ? json({ apiKey: fakeJwt(new Date(NOW.getTime() + KEY_LIFETIME_MS)) })
        : json(
            {
              code: 400,
              codeDescription: "CONNECTOR_REQUIRED_PARAMETER_VALIDATION_ERROR",
              message: "The parameter 'token' is required to be renewed for item update.",
            },
            400,
          ),
    );

    await assert.rejects(client.getConnection(ID), (error: Error) => {
      assert.match(error.message, /CONNECTOR_REQUIRED_PARAMETER_VALIDATION_ERROR/);
      assert.match(error.message, /'token' is required to be renewed/);
      return true;
    });
  });

  it("carries the retry-after date out of a login-failure lockout", async () => {
    const { client } = harness((request) =>
      isAuth(request)
        ? json({ apiKey: fakeJwt(new Date(NOW.getTime() + KEY_LIFETIME_MS)) })
        : json(
            {
              code: 400,
              codeDescription: "TOO_MANY_CONSECUTIVE_LOGIN_FAILURES",
              message: "Too many consecutive login failures.",
              data: { canRetryAfterDate: "2026-07-26T12:15:00.000Z" },
            },
            400,
          ),
    );

    await assert.rejects(client.getConnection(ID), (error: Error) => {
      assert.match(error.message, /retry after 2026-07-26T12:15:00.000Z/);
      return true;
    });
  });

  it("still says something useful when the error body is not an envelope", async () => {
    const { client } = harness((request) =>
      isAuth(request)
        ? json({ apiKey: fakeJwt(new Date(NOW.getTime() + KEY_LIFETIME_MS)) })
        : new Response("<html>gateway</html>", { status: 502 }),
    );

    await assert.rejects(client.getConnection(ID), (error: Error) => {
      assert.match(error.message, /502/);
      return true;
    });
  });

  it("falls back to a minute when the 429 names no delay", async () => {
    const { client, slept } = harness((request) =>
      isAuth(request)
        ? json({ apiKey: fakeJwt(new Date(NOW.getTime() + KEY_LIFETIME_MS)) })
        : json({ message: "slow down" }, 429),
    );

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
      return attempts === 1 ? json({ message: "slow down" }, 429, { "retry-after": "1" }) : json(itemBody(ID));
    });

    assert.equal((await client.getConnection(ID)).id, ID);
    assert.deepEqual(slept, [1_000]);
  });
});

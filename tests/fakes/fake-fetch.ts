import type { Fetch } from "../../src/pluggy/transport.ts";

export type RecordedRequest = {
  readonly method: string;
  readonly url: string;
  readonly apiKey: string | null;
  readonly contentType: string | null;
  readonly body: unknown;
};

export type FakeFetch = Fetch & {
  readonly requests: readonly RecordedRequest[];
};

export type Handler = (request: RecordedRequest, index: number) => Response | Promise<Response>;

/** Builds a JSON response the way the Pluggy API would. */
export function json(body: unknown, status = 200, headers: Readonly<Record<string, string>> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/**
 * A `fetch` that never touches the network, recording what it was asked for.
 * Injecting this is what makes the auth rules of ADR §15 Phase 0 testable —
 * margin, single-flight and the 401 retry are all invisible from the outside
 * otherwise.
 */
export function fakeFetch(handler: Handler): FakeFetch {
  const requests: RecordedRequest[] = [];

  const call: Fetch = async (url, init) => {
    const headers = new Headers(init.headers);

    let body: unknown;
    if (typeof init.body === "string") {
      body = JSON.parse(init.body);
    } else {
      body = undefined;
    }

    const recorded: RecordedRequest = {
      method: init.method ?? "GET",
      url,
      apiKey: headers.get("X-API-KEY"),
      contentType: headers.get("content-type"),
      body,
    };
    const index = requests.length;
    requests.push(recorded);

    return handler(recorded, index);
  };

  return Object.assign(call, { requests });
}

/** A JWT whose payload carries only the `exp` the client reads. */
export function fakeJwt(expiresAt: Date): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ exp: Math.floor(expiresAt.getTime() / 1000) })}.signature`;
}

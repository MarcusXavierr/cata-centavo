import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { slidingWindowLimiter } from "../../src/pluggy/transport.ts";
import { fixedClock } from "../fakes/fixed-clock.ts";

const NOW = new Date("2026-07-25T12:00:00.000Z");

describe("slidingWindowLimiter", () => {
  function limiterHarness(limit: number, windowMs: number) {
    const clock = fixedClock(NOW);
    const slept: number[] = [];
    const sleep = async (milliseconds: number): Promise<void> => {
      slept.push(milliseconds);
      clock.advance(milliseconds);
    };

    return { clock, slept, limiter: slidingWindowLimiter(clock, limit, windowMs, sleep) };
  }

  it("waits out the window once the limit is reached", async () => {
    const { limiter, slept } = limiterHarness(2, 1000);

    await limiter.acquire();
    await limiter.acquire();
    assert.deepEqual(slept, [], "waited before reaching the limit");

    await limiter.acquire();
    assert.deepEqual(slept, [1000]);
  });

  it("lets a request through once the old hits leave the window", async () => {
    const { limiter, clock, slept } = limiterHarness(2, 1000);

    await limiter.acquire();
    await limiter.acquire();
    clock.advance(1000);
    await limiter.acquire();

    assert.deepEqual(slept, []);
  });
});

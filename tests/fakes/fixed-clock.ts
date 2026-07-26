import type { Clock } from "../../src/core/contracts.ts";

export type FixedClock = Clock & {
  advance(milliseconds: number): void;
};

/**
 * A clock the test moves by hand. Lives outside `src/` so production code
 * cannot import it (ADR §6).
 */
export function fixedClock(start: Date): FixedClock {
  let current = start.getTime();

  return {
    now: () => new Date(current),
    advance: (milliseconds) => {
      current += milliseconds;
    },
  };
}

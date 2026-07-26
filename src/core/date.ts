import type { Clock } from "./contracts.ts";

const SAO_PAULO = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Sao_Paulo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * The calendar day an instant belongs to, in Brazil.
 *
 * Stored transaction dates use this same timezone so range filters and the
 * injected clock compare values in one calendar rather than mixing UTC with
 * Brazilian local time.
 */
export function localDayOf(instant: string): string {
  const date = new Date(instant);
  if (Number.isNaN(date.getTime())) {
    throw new RangeError(`Invalid date: ${instant}`);
  }

  return SAO_PAULO.format(date);
}

/** Today, in the same units every stored `localDate` is in. */
export function todayIn(clock: Clock): string {
  return localDayOf(clock.now().toISOString());
}

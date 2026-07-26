export function toDecimal(cents: number): string {
  let sign: string;
  if (cents < 0) {
    sign = "-";
  } else {
    sign = "";
  }
  const absoluteCents = Math.abs(cents);
  const whole = Math.trunc(absoluteCents / 100);
  const fraction = absoluteCents % 100;

  return `${sign}${whole}.${fraction.toString().padStart(2, "0")}`;
}

export function prune(value: unknown): unknown {
  if (value === null || value === undefined) {
    return undefined;
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      const pruned = prune(item);
      if (pruned === undefined) {
        return [];
      }
      return [pruned];
    });
  }

  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, item]) => {
        const pruned = prune(item);
        if (pruned === undefined) {
          return [];
        }
        return [[key, pruned]];
      }),
    );
  }

  return value;
}

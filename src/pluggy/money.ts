type DecimalDigits = {
  readonly coefficient: bigint;
  readonly decimalPlaces: number;
};

function parseDecimalDigits(value: number): DecimalDigits {
  const representation = Math.abs(value).toString();
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/.exec(representation);

  if (match === null) {
    throw new Error(`Cannot parse numeric value: ${representation}`);
  }

  const integerDigits = match[1] ?? "0";
  const fractionDigits = match[2] ?? "";
  const exponent = Number(match[3] ?? "0");

  return {
    coefficient: BigInt(`${integerDigits}${fractionDigits}`),
    decimalPlaces: fractionDigits.length - exponent,
  };
}

function roundDecimalCents({ coefficient, decimalPlaces }: DecimalDigits): bigint {
  if (decimalPlaces <= 2) {
    return coefficient * 10n ** BigInt(2 - decimalPlaces);
  }

  const divisor = 10n ** BigInt(decimalPlaces - 2);
  const whole = coefficient / divisor;
  const remainder = coefficient % divisor;

  let roundingUp: bigint;
  if (remainder * 2n >= divisor) {
    roundingUp = 1n;
  } else {
    roundingUp = 0n;
  }

  return whole + roundingUp;
}

/** Money as integer cents, rounded half away from zero without binary floats. */
export function toCents(value: number): number {
  if (!Number.isFinite(value)) {
    throw new RangeError("Money value must be finite");
  }

  let sign: number;
  if (value < 0) {
    sign = -1;
  } else {
    sign = 1;
  }

  const roundedCents = roundDecimalCents(parseDecimalDigits(value));
  const result = sign * Number(roundedCents);
  if (!Number.isSafeInteger(result)) {
    throw new RangeError("Money value exceeds the safe integer cent range");
  }

  if (result === 0) {
    return 0;
  }
  return result;
}

/**
 * Payment acquirers that stamp themselves onto the merchant name.
 *
 * This list is data and is expected to grow as real cases appear. Adding one
 * is one line here, one case in the table test, and a cache migration bump.
 */
const ACQUIRER_PREFIXES: readonly string[] = ["PAG*", "PG *", "PG*", "CIELO*", "REDE*", "STONE*", "MP *", "PAGSEGURO*"];

/** Corporate suffixes that carry no information about who was paid. */
const LEGAL_SUFFIXES: readonly string[] = ["LTDA", "ME", "EIRELI", "SA", "S/A", "EPP"];

const TRAILING_INSTALMENT = /\s+\d{1,2}\/\d{1,2}$/u;
const TRAILING_SEQUENCE = /\s+\d{5,}$/u;

function stripAcquirerPrefix(value: string): string {
  for (const prefix of ACQUIRER_PREFIXES) {
    if (value.startsWith(prefix)) {
      return value.slice(prefix.length).trim();
    }
  }

  return value;
}

function stripTrailingMarker(value: string): string {
  let result = value;

  if (TRAILING_INSTALMENT.test(result)) {
    result = result.replace(TRAILING_INSTALMENT, "").trim();
  }

  if (TRAILING_SEQUENCE.test(result)) {
    result = result.replace(TRAILING_SEQUENCE, "").trim();
  }

  return result;
}

function stripLegalSuffixes(value: string): string {
  let result = value;
  let changed = true;

  while (changed) {
    changed = false;

    for (const suffix of LEGAL_SUFFIXES) {
      if (result === suffix) {
        result = "";
        changed = true;
        break;
      }

      if (result.endsWith(` ${suffix}`)) {
        result = result.slice(0, -suffix.length - 1).trim();
        changed = true;
        break;
      }
    }
  }

  return result;
}

/** Normalize merchant descriptions into a stable grouping key. */
export function normalizeDescription(input: string): string {
  const withoutAccents = input.normalize("NFD").replace(/[\u0300-\u036f]/gu, "");
  const uppercased = withoutAccents.toUpperCase().replace(/\s+/gu, " ").trim();
  const withoutPrefix = stripAcquirerPrefix(uppercased);
  const withoutMarker = stripTrailingMarker(withoutPrefix);

  return stripLegalSuffixes(withoutMarker).replace(/\s+/gu, " ").trim();
}

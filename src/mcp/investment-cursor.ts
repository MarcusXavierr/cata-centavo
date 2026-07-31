import { createHash } from "node:crypto";

export type InvestmentCursorPosition = {
  readonly currency: string;
  readonly balanceCents: number;
  readonly institution: string;
  readonly name: string;
  readonly id: string;
};

export type InvestmentCursorFilter = {
  readonly connectionId: string | null;
};

export type DecodedInvestmentCursor =
  | { readonly ok: true; readonly position: InvestmentCursorPosition }
  | { readonly ok: false; readonly message: string };

type InvestmentCursorPayload = {
  readonly c: string;
  readonly b: number;
  readonly t: string;
  readonly n: string;
  readonly i: string;
  readonly f: string;
};

export function encodeCursor(position: InvestmentCursorPosition, filter: InvestmentCursorFilter): string {
  const payload = {
    c: position.currency,
    b: position.balanceCents,
    t: position.institution,
    n: position.name,
    i: position.id,
    f: fingerprint(filter),
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string, filter: InvestmentCursorFilter): DecodedInvestmentCursor {
  const payload = parseCursor(cursor);
  if (payload === null) {
    return { ok: false, message: "cursor is not valid base64url JSON" };
  }
  if (payload.f !== fingerprint(filter)) {
    return { ok: false, message: "cursor does not match this filter" };
  }
  return {
    ok: true,
    position: {
      currency: payload.c,
      balanceCents: payload.b,
      institution: payload.t,
      name: payload.n,
      id: payload.i,
    },
  };
}

function parseCursor(cursor: string): InvestmentCursorPayload | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!isRecord(parsed)) {
      return null;
    }
    return payloadFrom(parsed);
  } catch {
    return null;
  }
}

function payloadFrom(parsed: Record<string, unknown>): InvestmentCursorPayload | null {
  const stringFields = [parsed["c"], parsed["t"], parsed["n"], parsed["i"], parsed["f"]] as const;
  if (!stringFields.every((value) => typeof value === "string")) {
    return null;
  }

  const b = parsed["b"];
  if (typeof b !== "number" || !Number.isSafeInteger(b)) {
    return null;
  }

  const [c, t, n, i, f] = stringFields as readonly [string, string, string, string, string];
  return { c, b, t, n, i, f };
}

function fingerprint(filter: InvestmentCursorFilter): string {
  const canonical = { connectionId: filter.connectionId };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

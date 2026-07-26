import { createHash } from "node:crypto";

import type { TransactionFilter } from "../core/contracts.ts";

export type CursorPosition = {
  readonly localDate: string;
  readonly id: string;
};

export type DecodedCursor =
  | { readonly ok: true; readonly position: CursorPosition }
  | { readonly ok: false; readonly message: string };

export function encodeCursor(position: CursorPosition, filter: TransactionFilter): string {
  const payload = { d: position.localDate, i: position.id, f: fingerprint(filter) };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string, filter: TransactionFilter): DecodedCursor {
  const payload = parseCursor(cursor);
  if (payload === null) {
    return invalidCursor("cursor is not valid base64url JSON");
  }
  if (payload.f !== fingerprint(filter)) {
    return invalidCursor("cursor does not match these filters");
  }
  return { ok: true, position: { localDate: payload.d, id: payload.i } };
}

type CursorPayload = { readonly d: string; readonly i: string; readonly f: string };

function parseCursor(cursor: string): CursorPayload | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!isRecord(parsed)) {
      return null;
    }
    const d = parsed["d"];
    const i = parsed["i"];
    const f = parsed["f"];
    if (typeof d !== "string" || typeof i !== "string" || typeof f !== "string") {
      return null;
    }
    return { d, i, f };
  } catch {
    return null;
  }
}

function invalidCursor(message: string): DecodedCursor {
  return { ok: false, message };
}

function fingerprint(filter: TransactionFilter): string {
  const canonical: Record<string, unknown> = {};
  for (const key of Object.keys(filter).sort()) {
    if (key === "limit" || key === "after") {
      continue;
    }
    canonical[key] = filter[key as keyof TransactionFilter];
  }
  const stable = stableValue(canonical);
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (!isRecord(value)) {
    return value;
  }

  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = stableValue(value[key]);
  }
  return sorted;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

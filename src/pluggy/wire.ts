import { z } from "zod";

/**
 * The raw bodies we read from Pluggy, described rather than assumed.
 *
 * We do not reuse the SDK's entity types here, and the reason is specific: they
 * declare fields like `lastUpdatedAt` as `Date`, which is only true inside the
 * SDK, where a reviver installed in `got` turns every ISO-8601 string into a
 * `Date` (`transforms.js`). Parsing the body ourselves, the value is a string
 * and the type would be lying. Inferring from a schema makes that impossible.
 *
 * This is also ADR Phase 0.5 step 5 as code: trust nothing but the raw body.
 * The prior implementation could never observe that free-tier `category` comes
 * back null, because its own serializer deleted the evidence first (§16.2).
 *
 * Unknown keys are dropped, not rejected. Pluggy adding a field is not our
 * problem; Pluggy removing one we read is, and that is what these catch.
 */

export const AUTH_RESPONSE = z.object({
  apiKey: z.string().min(1),
});

/**
 * Why `statusDetail` may fall back to nothing rather than failing the parse: it
 * is a bag keyed by product name, its shape is documented only by example, and
 * what we read out of it is advisory — which product could not be updated this
 * time. Losing a whole completed sync to an unexpected key in an advisory field
 * would be the worse trade. Nothing about the money passes through here.
 */
const STATUS_DETAIL = z
  .record(
    z.string(),
    z
      .object({ warnings: z.array(z.object({ message: z.string() })).nullish() })
      .nullish(),
  )
  .nullish()
  .catch(null);

export const ITEM = z.object({
  id: z.string().min(1),
  connector: z.object({ name: z.string() }),
  status: z.string(),
  executionStatus: z.string().nullish(),
  lastUpdatedAt: z.string().nullable(),
  /** Present when the institution is waiting on a human. */
  parameter: z.object({ name: z.string(), label: z.string() }).nullish(),
  statusDetail: STATUS_DETAIL,
});

export type WireItem = z.infer<typeof ITEM>;

/**
 * Pluggy's error envelope. Read on every non-2xx, because the status alone is not
 * a diagnosis: `PATCH /items/{id}` documents four different 400s — a token that
 * needs renewing, an MFA parameter reused from the last execution, too many
 * consecutive errors, too many consecutive login failures — and only the body
 * says which. Throwing "Pluggy returned 400" and dropping the rest is §16.2's
 * scar, where the evidence was deleted before a human could see it.
 */
export const API_ERROR = z.object({
  codeDescription: z.string().nullish(),
  message: z.string().nullish(),
  data: z
    .object({ canRetryAfterDate: z.string().nullish() })
    .nullish()
    .catch(null),
});

/**
 * The one 400 that is an answer rather than a failure, recognised by its prose
 * because Pluggy gives us nothing else to recognise it by.
 *
 * Some connectors have no on-demand update at all, and asking anyway returns
 * `{"message": "MeuPluggy item cant be updated", "code": 400, "errorId": "…"}`
 * — verbatim from connector 200 on 2026-07-26, their typo included. Note what is
 * missing: no `codeDescription`, and `code` is the HTTP status echoed back rather
 * than a symbolic one. The refusal is undocumented (the four 400s in
 * `reference/items-update` all carry a `codeDescription`, and none of them is
 * this), and no connector field marks the capability either — `GET /connectors/200`
 * has `hasMFA`, `oauth`, `health`, `isOpenFinance`, `isSandbox` and five
 * `supports*` payment booleans, and nothing about updates. See
 * `docs/research/pluggy-item-update.md`.
 *
 * So: prose, deliberately, and the spelling is theirs — hence all three of
 * "cant", "can't" and "cannot", case-insensitively.
 */
export function refusesManualUpdate(detail: string | null): boolean {
  return detail !== null && /\bca(?:nn?ot|n'?t)\s+be\s+updated\b/i.test(detail);
}

/**
 * The body of a 409 from `PATCH /items/{id}`, described loosely on purpose. It
 * carries the interval Pluggy enforces and when the last sync landed, both worth
 * repeating to the user — but a refusal we cannot parse is still a refusal, so
 * every field here is optional and the caller copes with nulls.
 */
export const UPDATE_REFUSED = z.object({
  data: z
    .object({
      minUpdateFrequencyAllowedInHours: z.number().nullish(),
      lastUpdatedAt: z.string().nullish(),
    })
    .nullish(),
});

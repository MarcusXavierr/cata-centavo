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
 * a diagnosis: one 400 means a malformed request, another means a consent the
 * user revoked, and only `codeDescription` and `message` separate them. Throwing
 * "Pluggy returned 400" and dropping the rest is §16.2's scar, where the evidence
 * was deleted before a human could see it.
 *
 * Every field is optional and `data` falls back rather than failing, because an
 * error we cannot fully parse is still an error worth reporting.
 */
export const API_ERROR = z.object({
  codeDescription: z.string().nullish(),
  message: z.string().nullish(),
  data: z
    .object({ canRetryAfterDate: z.string().nullish() })
    .nullish()
    .catch(null),
});

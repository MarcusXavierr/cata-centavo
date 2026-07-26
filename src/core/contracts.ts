/**
 * The interfaces core requires of whoever serves it. They live here, not beside
 * their implementations, because a contract belongs to its consumer (ADR §6).
 *
 * Nothing in this file imports from `pluggy/`, `storage/` or `mcp/`, and that
 * includes the Pluggy SDK's types: the vocabulary here is ours (§14.0).
 */

/** Injectable time. Every freshness and expiry rule reads the clock (ADR §7). */
export type Clock = {
  now(): Date;
};

/** The other half of injectable time: waiting, for backoffs and poll loops. */
export type Sleep = (milliseconds: number) => Promise<void>;

/** O que acompanha uma linha de log. Nunca um valor de segredo (ADR §16.2). */
export type LogFields = Readonly<Record<string, unknown>>;

/**
 * O logger que o core exige de quem o serve. Declarado aqui, e não junto do
 * pino, porque o contrato pertence a quem consome (ADR §6) — `core/` não
 * importa pino, e o teste passa um fake em vez de mockar módulo.
 */
export type Logger = {
  debug(fields: LogFields, message: string): void;
  info(fields: LogFields, message: string): void;
  warn(fields: LogFields, message: string): void;
  error(fields: LogFields, message: string): void;
  child(fields: LogFields): Logger;
};

/**
 * A link to one financial institution. Pluggy calls this an *item*; no human
 * does, so the domain word is "connection" and the translation stays inside
 * `pluggy/mapper.ts` (ADR §14.0).
 */
export type Connection = {
  readonly id: string;
  readonly institution: string;
  /**
   * Left open as a string on purpose. The SDK's `ITEM_STATUSES` omits
   * `PARTIAL_SUCCESS` while its own docblock two lines below describes an item
   * having exactly that status, so the set is not trustworthy enough to close.
   * Phase 0.5 sees real data and can close it then; until then an unrecognised
   * status is displayed rather than rejected, because losing a whole connection
   * report to an unknown enum value is the worse failure.
   */
  readonly status: string;
  /**
   * The finer-grained progress signal underneath `status`, and open for a
   * stronger reason than `status` is: Pluggy's OpenAPI schema declares it a bare
   * `string` with no enum at all, while its prose docs and its own SDK disagree
   * about the members — down to the spelling of the investments one. See
   * `docs/research/pluggy-item-update.md`.
   */
  readonly executionStatus: string | null;
  readonly lastUpdatedAt: Date | null;
  /** The label of what the bank is asking a human for, when it is asking. */
  readonly parameter: string | null;
  /**
   * Why a sync came back `PARTIAL_SUCCESS` — typically a product that hit its
   * Open Finance monthly quota. Empty rather than absent, because a caller that
   * has to check for undefined is a caller that will forget to.
   */
  readonly warnings: readonly string[];
};

/**
 * What Pluggy says the moment a refresh is asked for. Two of the three answers
 * are refusals and neither is a failure.
 *
 * `too-soon`: Pluggy enforces a minimum interval between updates per client and
 * refuses with the timestamp of the last one, which is the debounce ADR §11
 * wanted and never had to build.
 *
 * `not-refreshable`: the connector has no on-demand update at all, whatever
 * state the connection is in. It carries nothing because there is nothing to
 * carry — the connection is exactly as it was before we asked, and the caller
 * already holds it.
 */
export type RefreshStart =
  | { readonly kind: "started"; readonly connection: Connection }
  | {
      readonly kind: "too-soon";
      readonly everyHours: number | null;
      readonly lastUpdatedAt: Date | null;
    }
  | { readonly kind: "not-refreshable" };

/** What `init` needs from whoever holds the credentials. */
export type Bank = {
  /** Rejects when the credentials are refused. One round trip, no side effects. */
  verifyCredentials(): Promise<void>;
  /** Rejects when the id is unknown, or when the request cannot be made. */
  getConnection(id: string): Promise<Connection>;
  /**
   * Asks the institution for fresh data. Costs Open Finance product quota and is
   * rate limited an order of magnitude tighter than the read paths, so it fires
   * only when a human asked for it — never on a schedule (§11).
   */
  refreshConnection(id: string): Promise<RefreshStart>;
};

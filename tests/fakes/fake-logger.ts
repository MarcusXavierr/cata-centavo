import type { LogFields, Logger } from "../../src/core/contracts.ts";

export type CapturedLine = {
  readonly level: "debug" | "info" | "warn" | "error";
  readonly fields: LogFields;
  readonly message: string;
};

/** Accumula num array em vez de escrever. Vive em tests/. */
export function fakeLogger(): Logger & { readonly lines: readonly CapturedLine[] } {
  const lines: CapturedLine[] = [];

  const at = (level: CapturedLine["level"]) => (fields: LogFields, message: string) => {
    lines.push({ level, fields, message });
  };

  const log: Logger & { readonly lines: readonly CapturedLine[] } = {
    lines,
    debug: at("debug"),
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
    child(bound: LogFields): Logger {
      return {
        ...log,
        debug: (fields, message) => log.debug({ ...bound, ...fields }, message),
        info: (fields, message) => log.info({ ...bound, ...fields }, message),
        warn: (fields, message) => log.warn({ ...bound, ...fields }, message),
        error: (fields, message) => log.error({ ...bound, ...fields }, message),
      };
    },
  };

  return log;
}

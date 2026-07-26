import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { Writable } from "node:stream";

import pino, { type DestinationStream, type Logger as PinoLogger } from "pino";

import type { Env } from "./config.ts";
import type { Logger } from "./core/contracts.ts";

export type LoggerOptions = {
  readonly env: Env;
  readonly logFile: string | null;
  readonly write?: (line: string) => void;
};

const REDACT_PATHS = [
  "clientSecret",
  "apiKey",
  "authorization",
  "key",
  "*.clientSecret",
  "*.apiKey",
  "*.authorization",
  "*.key",
];

/**
 * Builds the process logger. The real stderr destination is fd 2 because fd 1
 * is the MCP JSON-RPC channel. File failures degrade to stderr only.
 */
export function createLogger(options: LoggerOptions): Logger {
  const level = options.env.CATA_CENTAVO_LOG_LEVEL ?? "info";
  const stderrLevel = level === "debug" ? "debug" : "warn";
  const stderr = options.write === undefined ? pino.destination({ dest: 2, sync: true }) : testDestination(options.write);
  const streams: Array<{ level: string; stream: DestinationStream }> = [
    { level: stderrLevel, stream: stderr },
  ];

  const file = fileStream(options, level);
  if (file !== null) streams.push(file);

  const root = pino(
    {
      level,
      // Pino's runtime sentinel for the design's `base: undefined` is null;
      // it omits pid and hostname without violating exactOptionalPropertyTypes.
      base: null,
      redact: { paths: REDACT_PATHS, censor: "[Redacted]" },
    },
    pino.multistream(streams),
  );

  return wrap(root);
}

/** Null whenever the file is switched off, unconfigured, or could not be opened. */
function fileStream(
  options: LoggerOptions,
  level: string,
): { level: string; stream: DestinationStream } | null {
  if (options.logFile === null || options.env.CATA_CENTAVO_LOG_FILE === "off") {
    return null;
  }

  const stream = createFileDestination(options.logFile);
  return stream === null ? null : { level, stream };
}

function wrap(log: PinoLogger): Logger {
  return {
    debug: (fields, message) => log.debug(fields, message),
    info: (fields, message) => log.info(fields, message),
    warn: (fields, message) => log.warn(fields, message),
    error: (fields, message) => log.error(fields, message),
    child: (fields) => wrap(log.child(fields)),
  };
}

function testDestination(write: (line: string) => void): DestinationStream {
  return new Writable({
    write(chunk, _encoding, callback) {
      write(String(chunk));
      callback();
    },
  });
}

function createFileDestination(path: string): DestinationStream | null {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const descriptor = openSync(path, "a", 0o600);
    closeSync(descriptor);
    chmodSync(path, 0o600);

    return pino.transport({
      target: "pino-roll",
      options: { file: path, size: "5m", mkdir: true, mode: 0o600 },
    });
  } catch {
    return null;
  }
}

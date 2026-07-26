import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createLogger } from "../src/logging.ts";

describe("createLogger", () => {
  it("never writes to stdout, because stdout is the JSON-RPC channel (ADR §4)", () => {
    const written: string[] = [];
    const log = createLogger({ env: {}, logFile: null, write: (line) => written.push(line) });

    log.error({ code: "E_TEST" }, "boom");

    assert.equal(written.length, 1);
    assert.match(written[0] ?? "", /"msg":"boom"/);
  });

  it("redacts a credential instead of writing it", () => {
    const written: string[] = [];
    const log = createLogger({ env: {}, logFile: null, write: (line) => written.push(line) });

    log.error({ clientSecret: "s3cr3t", apiKey: "eyJhbGciOi" }, "auth failed");

    const line = written[0] ?? "";
    assert.doesNotMatch(line, /s3cr3t/);
    assert.doesNotMatch(line, /eyJhbGciOi/);
    assert.match(line, /\[Redacted\]/);
  });

  it("omits pid and hostname, which say nothing in a local CLI", () => {
    const written: string[] = [];
    const log = createLogger({ env: {}, logFile: null, write: (line) => written.push(line) });

    log.warn({}, "hello");

    assert.doesNotMatch(written[0] ?? "", /"pid"|"hostname"/);
  });

  it("keeps info quiet on stderr while warn remains visible there", () => {
    const written: string[] = [];
    const log = createLogger({ env: {}, logFile: null, write: (line) => written.push(line) });

    log.info({}, "só no arquivo");
    log.warn({}, "nos dois");

    assert.equal(written.length, 1);
    assert.match(written[0] ?? "", /nos dois/);
  });

  it("raises both levels when CATA_CENTAVO_LOG_LEVEL is set", () => {
    const written: string[] = [];
    const log = createLogger({
      env: { CATA_CENTAVO_LOG_LEVEL: "debug" },
      logFile: null,
      write: (line) => written.push(line),
    });

    log.debug({}, "visível agora");

    assert.equal(written.length, 1);
  });
});

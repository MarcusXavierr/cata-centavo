import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createProgress, FRAME_MS, SPINNER } from "../../src/cli/progress.ts";

const ESCAPE = /\x1b\[/;

function harness(tty: boolean) {
  const written: string[] = [];
  const ticks: { callback: () => void; ms: number; cancelled: boolean }[] = [];

  const progress = createProgress({
    write: (text) => {
      written.push(text);
    },
    tty,
    interval: (callback, ms) => {
      const tick = { callback, ms, cancelled: false };
      ticks.push(tick);
      return {
        cancel: () => {
          tick.cancelled = true;
        },
      };
    },
  });

  return {
    progress,
    written,
    ticks,
    text: () => written.join(""),
    /** What the last write put on screen, escape codes stripped. */
    last: () => (written.at(-1) ?? "").replaceAll(/\x1b\[[0-9?]*[A-Za-z]/g, ""),
  };
}

describe("createProgress on a terminal", () => {
  it("hides the cursor before drawing over the screen", () => {
    const { progress, text } = harness(true);

    progress.update([{ label: "Nubank", detail: "logging in" }]);

    assert.match(text(), /\x1b\[\?25l/);
  });

  it("names the institution and what it is doing", () => {
    const { progress, last } = harness(true);

    progress.update([{ label: "Nubank", detail: "reading transactions" }]);

    assert.match(last(), /Nubank/);
    assert.match(last(), /reading transactions/);
  });

  it("redraws over the previous lines instead of scrolling", () => {
    const { progress, written } = harness(true);

    progress.update([
      { label: "Nubank", detail: "logging in" },
      { label: "Itaú", detail: "logging in" },
    ]);
    progress.update([
      { label: "Nubank", detail: "reading accounts" },
      { label: "Itaú", detail: "logging in" },
    ]);

    assert.match(written.at(-1) ?? "", /\x1b\[2A/, "did not go back up over the two lines it drew");
  });

  it("advances the spinner when the ticker fires", () => {
    const { progress, ticks, written } = harness(true);

    progress.update([{ label: "Nubank", detail: "logging in" }]);
    const first = written.at(-1) ?? "";

    assert.equal(ticks.length, 1);
    assert.equal(ticks[0]?.ms, FRAME_MS);
    ticks[0]?.callback();

    const second = written.at(-1) ?? "";
    assert.notEqual(first, second, "the spinner never moved");
    assert.ok(SPINNER.some((frame) => second.includes(frame)));
  });

  it("starts one ticker however many times it is updated", () => {
    const { progress, ticks } = harness(true);

    progress.update([{ label: "Nubank", detail: "logging in" }]);
    progress.update([{ label: "Nubank", detail: "reading accounts" }]);
    progress.update([{ label: "Nubank", detail: "reading transactions" }]);

    assert.equal(ticks.length, 1);
  });

  it("clears the lines a finished connection leaves behind", () => {
    const { progress, last } = harness(true);

    progress.update([
      { label: "Nubank", detail: "logging in" },
      { label: "Itaú", detail: "logging in" },
    ]);
    progress.update([{ label: "Itaú", detail: "logging in" }]);

    assert.doesNotMatch(last(), /Nubank/, "left a finished connection on screen");
  });

  it("gives the cursor back and stops the ticker when it stops", () => {
    const { progress, ticks, written, text } = harness(true);

    progress.update([{ label: "Nubank", detail: "logging in" }]);
    progress.stop();

    assert.match(text(), /\x1b\[\?25h/, "left the cursor hidden");
    assert.equal(ticks[0]?.cancelled, true);
    assert.doesNotMatch((written.at(-1) ?? "").replaceAll(/\x1b\[[0-9?]*[A-Za-z]/g, ""), /Nubank/);
  });

  it("stops only once, however often it is asked", () => {
    const { progress, written } = harness(true);

    progress.update([{ label: "Nubank", detail: "logging in" }]);
    progress.stop();
    const after = written.length;
    progress.stop();

    assert.equal(written.length, after);
  });

  it("draws nothing at all when there is nothing in flight", () => {
    const { progress, written, ticks } = harness(true);

    progress.update([]);

    assert.deepEqual(written, []);
    assert.equal(ticks.length, 0);
  });
});

describe("createProgress off a terminal", () => {
  it("writes no escape codes, so a log stays readable", () => {
    const { progress, text } = harness(false);

    progress.update([{ label: "Nubank", detail: "logging in" }]);
    progress.update([{ label: "Nubank", detail: "reading accounts" }]);
    progress.stop();

    assert.doesNotMatch(text(), ESCAPE);
  });

  it("says something only when the stage changes", () => {
    const { progress, written } = harness(false);

    progress.update([{ label: "Nubank", detail: "logging in" }]);
    progress.update([{ label: "Nubank", detail: "logging in" }]);
    progress.update([{ label: "Nubank", detail: "reading accounts" }]);

    assert.deepEqual(
      written.map((line) => line.trim()),
      ["· Nubank — logging in", "· Nubank — reading accounts"],
    );
  });

  it("keeps two connections' stages apart", () => {
    const { progress, written } = harness(false);

    progress.update([
      { label: "Nubank", detail: "logging in" },
      { label: "Itaú", detail: "logging in" },
    ]);
    progress.update([
      { label: "Nubank", detail: "reading accounts" },
      { label: "Itaú", detail: "logging in" },
    ]);

    assert.equal(written.length, 3);
    assert.match(written.at(-1) ?? "", /Nubank — reading accounts/);
  });

  it("never starts a ticker there is no way to see", () => {
    const { progress, ticks } = harness(false);

    progress.update([{ label: "Nubank", detail: "logging in" }]);

    assert.equal(ticks.length, 0);
  });
});

describe("createProgress", () => {
  it("writes only through the sink it was given, never to stdout", () => {
    const original = process.stdout.write.bind(process.stdout);
    const escaped: unknown[] = [];
    process.stdout.write = ((chunk: unknown) => {
      escaped.push(chunk);
      return true;
    }) as typeof process.stdout.write;

    try {
      for (const tty of [true, false]) {
        const { progress } = harness(tty);
        progress.update([{ label: "Nubank", detail: "logging in" }]);
        progress.update([{ label: "Nubank", detail: "reading transactions" }]);
        progress.stop();
      }
    } finally {
      process.stdout.write = original;
    }

    assert.deepEqual(escaped, [], "stdout is the JSON-RPC channel and must stay empty (ADR §4)");
  });
});

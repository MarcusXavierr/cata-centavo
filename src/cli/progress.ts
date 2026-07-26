/**
 * The live region `init` draws while it waits on the banks.
 *
 * A refresh can take minutes — Pluggy documents the login step alone taking up
 * to five — so silence is not an option. On a terminal this redraws a block of
 * lines in place with a spinner; anywhere else it appends a line whenever a stage
 * changes, because escape codes in a log file are worse than no animation.
 *
 * Everything about time and terminal-ness is injected, which is what makes the
 * whole thing testable without a PTY. `write` is the only sink: nothing here may
 * reach stdout, which in server mode *is* the protocol channel (ADR §4).
 */

export type Row = {
  /** Who: the institution's name, or the id when we do not have one yet. */
  readonly label: string;
  /** What it is doing, from `stageLabel`. */
  readonly detail: string;
};

export type Ticker = { cancel(): void };

export type ProgressDeps = {
  readonly write: (text: string) => void;
  readonly tty: boolean;
  readonly interval: (callback: () => void, ms: number) => Ticker;
};

export type Progress = {
  /** The connections still in flight. Settled ones are simply absent. */
  update(rows: readonly Row[]): void;
  /** Clears the region and gives the cursor back. Safe to call twice. */
  stop(): void;
};

export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
export const FRAME_MS = 80;

const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const CLEAR_LINE = "\x1b[2K";

const up = (lines: number): string => (lines > 0 ? `\x1b[${lines}A` : "");

export function createProgress(deps: ProgressDeps): Progress {
  return deps.tty ? liveRegion(deps) : appendOnChange(deps);
}

function liveRegion(deps: ProgressDeps): Progress {
  let rows: readonly Row[] = [];
  let drawn = 0;
  let frame = 0;
  let ticker: Ticker | null = null;
  let stopped = false;

  function draw(): void {
    const lines = rows.map((row) => `${SPINNER[frame % SPINNER.length] ?? ""} ${row.label} — ${row.detail}…`);
    const surplus = Math.max(0, drawn - lines.length);

    const painted = lines.map((line) => `${CLEAR_LINE}${line}\n`).join("");
    const cleared = `${CLEAR_LINE}\n`.repeat(surplus);

    deps.write(`${up(drawn)}${painted}${cleared}${up(surplus)}`);
    drawn = lines.length;
  }

  return {
    update: (next) => {
      if (stopped || (next.length === 0 && drawn === 0)) {
        return;
      }

      rows = next;

      if (ticker === null) {
        deps.write(HIDE_CURSOR);
        ticker = deps.interval(() => {
          frame += 1;
          draw();
        }, FRAME_MS);
      }

      draw();
    },

    stop: () => {
      if (stopped) {
        return;
      }
      stopped = true;

      ticker?.cancel();
      ticker = null;

      if (drawn > 0) {
        rows = [];
        draw();
      }

      deps.write(SHOW_CURSOR);
    },
  };
}

/**
 * A stage per line, once. Repeating "logging in" forty times as the poll loop
 * comes back around would bury the report that follows it.
 */
function appendOnChange(deps: ProgressDeps): Progress {
  const said = new Map<string, string>();

  return {
    update: (rows) => {
      for (const row of rows) {
        if (said.get(row.label) === row.detail) {
          continue;
        }
        said.set(row.label, row.detail);
        deps.write(`· ${row.label} — ${row.detail}\n`);
      }
    },

    stop: () => {},
  };
}

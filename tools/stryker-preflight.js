/**
 * Refuses to start a mutation run that would hang forever.
 *
 * Stryker copies the project into `.stryker-tmp/sandbox-*` by opening every
 * file it does not ignore. `open()` on a FIFO with no writer attached blocks in
 * the kernel with no timeout, so one stray named pipe in the working tree turns
 * `npm run mutation` into a silent process that never finishes and never says
 * why — we lost a run to a 0-byte `wait_finish_task_5_7` left in the repo root,
 * and a stryker process sat on it for five hours before anyone noticed.
 *
 * `lstat` and the dirent type never open anything, so walking the same tree
 * costs milliseconds and cannot itself block. The `**\/*.sock` already in
 * `stryker.config.json` is the scar from the sensors socket hitting this first.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

const CONFIG = "stryker.config.json";

/**
 * Stryker's built-in ignores. A user's `ignorePatterns` extend this list rather
 * than replacing it, so the check has to know both to agree with what actually
 * gets copied.
 */
const DEFAULTS = ["node_modules", ".git", "/reports", "*.tsbuildinfo", "/.stryker-tmp"];

/** Everything a glob may contain that a regular expression reads differently. */
function escape(segment) {
  return segment.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]");
}

/**
 * A gitignore-shaped pattern as a regular expression: `**` spans directories, a
 * leading `/` anchors to the project root, and a bare name matches at any depth.
 * Matching a directory matches everything under it.
 */
function toRegExp(pattern) {
  const anchored = pattern.startsWith("/");
  const segments = pattern.replace(/^\//, "").replace(/\/$/, "").split("/");

  let source = "";
  for (const [index, segment] of segments.entries()) {
    const last = index === segments.length - 1;

    if (segment === "**") {
      source += last ? ".*" : "(?:[^/]+/)*";
      continue;
    }

    source += last ? escape(segment) : `${escape(segment)}/`;
  }

  return new RegExp(`^${anchored ? "" : "(?:.*/)?"}${source}(?:/.*)?$`);
}

/**
 * Whether Stryker leaves this path out of the sandbox.
 *
 * Negations are dropped rather than honoured. A `!pattern` un-ignores a path,
 * so reading it as an ignore would report a copied file as safe — the one error
 * that brings the hang back. Over-reporting only costs a message.
 */
export function ignored(path, patterns = []) {
  return [...DEFAULTS, ...patterns]
    .filter((pattern) => !pattern.startsWith("!"))
    .some((pattern) => toRegExp(pattern).test(path));
}

/**
 * Every FIFO and socket Stryker would try to copy, relative to `root`.
 *
 * Symlinks are resolved because Stryker copies them by target — `AGENTS.md`
 * lands in the sandbox as the contents of `CLAUDE.md`. A symlinked directory is
 * still not descended into, which keeps the walk free of cycles.
 */
export async function scan(root, patterns = []) {
  const found = [];

  async function walk(relative) {
    for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
      const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (ignored(path, patterns)) continue;

      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }

      if (entry.isFIFO() || entry.isSocket()) {
        found.push(path);
        continue;
      }

      if (!entry.isSymbolicLink()) continue;

      try {
        const target = await stat(join(root, path));
        if (target.isFIFO() || target.isSocket()) found.push(path);
      } catch {
        continue;
      }
    }
  }

  await walk("");
  return found.sort();
}

export function render(paths) {
  return [
    `Refusing to run Stryker: ${paths.length} unopenable file(s) in the sandbox scope.`,
    "",
    ...paths.map((path) => `  ${path}`),
    "",
    "Stryker copies these by opening them, and a FIFO or socket with nothing",
    "attached blocks that open forever — the run hangs with no output at all.",
    "Delete them, or add them to ignorePatterns in stryker.config.json.",
    "",
  ].join("\n");
}

async function main() {
  const { ignorePatterns } = JSON.parse(await readFile(CONFIG, "utf8"));
  const offenders = await scan(process.cwd(), ignorePatterns ?? []);

  if (offenders.length === 0) return;

  process.stderr.write(render(offenders));
  process.exitCode = 1;
}

if (process.argv[1]?.endsWith("stryker-preflight.js")) {
  await main();
}

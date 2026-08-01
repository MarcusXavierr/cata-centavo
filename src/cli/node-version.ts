/**
 * The floor declared in package.json "engines.node". Duplicated here because a
 * runtime check cannot wait for a JSON read that may itself be the thing that
 * fails; `tests/cli/node-version.test.ts` turns the duplication into a test
 * failure the moment the two drift apart.
 */
export const MINIMUM_NODE = "22.13.0";

function parse(version: string): readonly number[] {
  return version.split(".").map((part) => Number.parseInt(part, 10));
}

function isOlder(running: readonly number[], minimum: readonly number[]): boolean {
  for (const [index, floor] of minimum.entries()) {
    const part = running[index] ?? 0;
    if (part !== floor) return part < floor;
  }
  return false;
}

/**
 * The message to print when the running Node cannot execute this package, or
 * `null` when it can.
 *
 * `node:sqlite` arrives through a static import three modules below the entry
 * point, so an old Node fails during module resolution — before any of our code
 * runs, and with an ERR_UNKNOWN_BUILTIN_MODULE stack trace from inside the
 * loader. This is why src/bin/cata-centavo.ts imports the rest of the program
 * dynamically. A version we cannot read is allowed through: refusing to start
 * on an unfamiliar version string is worse than the crash it would prevent.
 */
export function nodeVersionProblem(running: string): string | null {
  const parts = parse(running);
  if (parts.length === 0 || parts.some(Number.isNaN)) return null;
  if (!isOlder(parts, parse(MINIMUM_NODE))) return null;

  return `cata-centavo needs Node ${MINIMUM_NODE} or newer, and this is Node ${running}.

npx runs whichever node comes first on PATH, and an MCP client does not read
your shell profile, so that is often not the node you get in a terminal. Give
the client an absolute path to a newer node, or upgrade the one your system
starts with.`;
}

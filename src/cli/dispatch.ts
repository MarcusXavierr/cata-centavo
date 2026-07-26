import { parseArgs } from "node:util";

/**
 * A `const` object plus a derived union, instead of `enum`.
 *
 * ADR §13 recommends this: `enum` is not erasable syntax, so `erasableSyntaxOnly`
 * rejects it — and a TS string enum is *nominal*, meaning a string arriving from
 * JSON cannot be assigned to it without a cast, precisely where we want real
 * validation instead.
 */
export const COMMANDS = {
  init: "init",
  doctor: "doctor",
  serve: "serve",
} as const;

export type Command = (typeof COMMANDS)[keyof typeof COMMANDS];

/** Discriminated union: the caller is forced to handle every case. */
export type Invocation =
  | { readonly kind: "command"; readonly command: Command }
  | { readonly kind: "help" }
  | { readonly kind: "version" }
  | { readonly kind: "error"; readonly message: string };

function isCommand(value: string): value is Command {
  return Object.hasOwn(COMMANDS, value);
}

/**
 * Translates argv into an intent. Pure: reads no environment, writes nowhere,
 * never exits the process. That is what makes it testable.
 */
export function resolveInvocation(argv: readonly string[]): Invocation {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    // parseArgs throws on an unknown flag. Returning it as a value keeps this
    // function pure and leaves the choice of how to fail with the caller.
    return {
      kind: "error",
      message: error instanceof Error ? error.message : String(error),
    };
  }

  if (parsed.values.help === true) return { kind: "help" };
  if (parsed.values.version === true) return { kind: "version" };

  return commandFrom(parsed.positionals);
}

function commandFrom(positionals: readonly string[]): Invocation {
  const [first, ...rest] = positionals;

  if (rest.length > 0) {
    return { kind: "error", message: `unexpected argument: ${rest[0]}` };
  }

  // No argument = MCP server over stdio (ADR §4).
  if (first === undefined) {
    return { kind: "command", command: COMMANDS.serve };
  }

  if (!isCommand(first)) {
    return { kind: "error", message: `unknown command: ${first}` };
  }

  return { kind: "command", command: first };
}

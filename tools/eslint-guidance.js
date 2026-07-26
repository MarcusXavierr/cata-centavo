/**
 * Self-correction guidance, keyed by ESLint rule.
 *
 * Shared by the two formatters — `eslint-formatter-agent.js` renders it as text
 * for a human reading a terminal, `eslint-formatter-sensor.js` ships it as JSON
 * to the sensors sidecar. One copy, because a rule whose guidance drifts between
 * the two channels is worse than a rule with none.
 *
 * A rule missing from this map is not an error: both formatters fall back to
 * ESLint's own message, so adding a rule never breaks either one.
 */
export const GUIDANCE = {
  complexity: `Too much branching in one function. Extract the branches into named
functions and test each one — CLAUDE.md already asks for this ("if a
comment is needed to explain a section, that section is a function").

If refactoring does not pay off, there are two exits, both visible in
the diff:
  /* eslint complexity: ["warn", 7] */                 (ceiling is 7)
  // eslint-disable-next-line complexity -- (reason)`,

  "max-lines-per-function": `Function too long to hold in the reader's head. Find the point where it
changes subject and cut there.

A factory that assembles and returns an object is usually a legitimate
exception:
  // eslint-disable-next-line max-lines-per-function -- (reason)`,

  "max-lines": `File too large. It is normally doing two things. Split off the one with
fewer ties to the rest.`,

  "max-params": `Too many parameters. Group the related ones into a named object, which
also removes the chance of swapping two of the same type.`,

  "max-depth": `Deep nesting. Invert the conditions and return early, or extract the
inner block into a named function.`,

  "max-statements": `Too many steps in one function. Grouping the steps that share variables
and naming the group is usually cheap.`,

  "@typescript-eslint/no-explicit-any": `\`any\` switches off type checking exactly where it would protect you.
Prefer \`unknown\` and narrow with a check, which the compiler enforces.

Make the call: if the type genuinely does not exist, suppress with a reason.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- (reason)`,

  "@typescript-eslint/no-floating-promises": `A promise with no \`await\`, \`.catch\` or explicit \`void\`. The rejection
disappears, and in this project what disappears tends to be money that
was never paginated.`,

  "no-console": `\`console\` writes to stdout, and in server mode stdout is the JSON-RPC
channel (ADR §4). One line here corrupts the protocol.

Use the injected \`Logger\`, or \`say()\` in src/bin/ for human-facing text.`,

  "local/complexity-ceiling": `The ceiling of 7 is deliberate. Past it, the answer is to extract
functions.`,

  "local/require-disable-reason": `A suppression with no reason is indistinguishable from giving up. Write
the \`-- reason\` explaining why the rule is wrong at this point.`,
};

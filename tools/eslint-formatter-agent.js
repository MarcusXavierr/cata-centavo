/**
 * Formatter that groups by rule rather than by file, and attaches actionable
 * guidance to each one.
 *
 * The inversion is the point: the reader sees "complexity blew up in three
 * places, here is what to do about complexity" instead of three files with one
 * cryptic line each. See "Sensors for coding agents" (Martin Fowler, 2026) and
 * the design document at docs/plans/2026-07-26-eslint-and-logging-design.md.
 *
 * A rule missing from the map falls back to ESLint's own message, so adding a
 * rule never breaks this file.
 */

const GUIDANCE = {
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

const SEVERITY = { 1: "warning", 2: "error" };

function relative(filePath) {
  return filePath.replace(`${process.cwd()}/`, "");
}

function groupByRule(results) {
  const groups = new Map();

  for (const result of results) {
    for (const message of result.messages) {
      const rule = message.ruleId ?? "(parsing error)";
      const group = groups.get(rule) ?? { rule, severity: message.severity, entries: [] };
      group.severity = Math.max(group.severity, message.severity);
      group.entries.push({
        where: `${relative(result.filePath)}:${message.line}`,
        what: message.message,
      });
      groups.set(rule, group);
    }
  }

  return [...groups.values()].sort((a, b) => b.severity - a.severity);
}

function renderGroup(group) {
  const plural = group.entries.length === 1 ? "occurrence" : "occurrences";
  const header = `${group.rule} · ${group.entries.length} ${plural} · ${SEVERITY[group.severity]}`;
  const width = Math.max(...group.entries.map((entry) => entry.where.length));
  const lines = group.entries.map((entry) => `  ${entry.where.padEnd(width)}  ${entry.what}`);
  const guidance = GUIDANCE[group.rule];

  return [
    header,
    "",
    ...lines,
    ...(guidance === undefined ? [] : ["", guidance.replace(/^/gm, "  ")]),
    "",
  ].join("\n");
}

export default function agentFormatter(results) {
  const groups = groupByRule(results);
  if (groups.length === 0) return "";

  const errors = groups
    .flatMap((group) => group.entries.map(() => group.severity))
    .filter((severity) => severity === 2).length;
  const warnings = groups
    .flatMap((group) => group.entries.map(() => group.severity))
    .filter((severity) => severity === 1).length;

  const footer =
    `${errors} ${errors === 1 ? "error" : "errors"} (fail the build), ` +
    `${warnings} ${warnings === 1 ? "warning" : "warnings"} (do not).`;

  return ["", ...groups.map(renderGroup), footer, ""].join("\n");
}

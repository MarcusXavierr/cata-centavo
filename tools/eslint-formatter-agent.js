/**
 * Formatter that groups by rule rather than by file, and attaches actionable
 * guidance to each one.
 *
 * The inversion is the point: the reader sees "complexity blew up in three
 * places, here is what to do about complexity" instead of three files with one
 * cryptic line each. See "Sensors for coding agents" (Martin Fowler, 2026) and
 * the design document at docs/plans/2026-07-26-eslint-and-logging-design.md.
 *
 * The guidance itself lives in `eslint-guidance.js`, shared with the JSON
 * formatter the sensors sidecar reads. A rule missing from it falls back to
 * ESLint's own message, so adding a rule never breaks this file.
 */

import { GUIDANCE } from "./eslint-guidance.js";

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

function ruleGroups(violations) {
  const groups = new Map();

  for (const violation of violations) {
    const name = violation.rule.name;
    const group = groups.get(name) ?? { name, severity: violation.rule.severity, violations: [] };
    group.violations.push(violation);
    groups.set(name, group);
  }

  return [...groups.values()].sort((left, right) => {
    if (left.severity === right.severity) return left.name.localeCompare(right.name);
    return left.severity === "error" ? -1 : 1;
  });
}

function violationPath(violation) {
  if (violation.type !== "cycle") {
    return violation.from === violation.to ? violation.from : `${violation.from} → ${violation.to}`;
  }

  return [violation.from, ...violation.cycle.map((module) => module.name), violation.from].join(" → ");
}

function renderGroup(group, guidance) {
  const count = group.violations.length;
  const plural = count === 1 ? "occurrence" : "occurrences";
  const lines = group.violations.map((violation) => `  ${violationPath(violation)}`);
  const guidanceLines = guidance === undefined ? [] : ["", `  ${guidance}`];

  return [
    `${group.name} · ${count} ${plural} · ${group.severity}`,
    "",
    ...lines,
    ...guidanceLines,
    "",
  ].join("\n");
}

function footer(errorCount, warningCount) {
  const errors = `${errorCount} ${errorCount === 1 ? "error" : "errors"} (fail${errorCount === 1 ? "s" : ""} the build)`;
  const warnings = `${warningCount} ${warningCount === 1 ? "warning" : "warnings"} (do${warningCount === 1 ? "es" : ""} not)`;
  return `${errors}, ${warnings}.`;
}

export default function reporter(cruiseResult) {
  const { violations, error, warn, ruleSetUsed } = cruiseResult.summary;
  if (violations.length === 0) return { output: "", exitCode: 0 };

  const guidance = new Map(ruleSetUsed.forbidden.map((rule) => [rule.name, rule.comment]));
  const groups = ruleGroups(violations);
  const output = ["", ...groups.map((group) => renderGroup(group, guidance.get(group.name))), footer(error, warn), ""].join("\n");

  return { output, exitCode: error };
}

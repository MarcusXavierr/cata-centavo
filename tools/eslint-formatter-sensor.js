/**
 * The same report as `eslint-formatter-agent.js`, addressed to a machine.
 *
 * The sensors sidecar parses ESLint through its own reader, which wants JSON
 * with a `triggeredRules` block; the terminal wants prose grouped by rule.
 * Rather than pick one, both formatters exist and share `eslint-guidance.js`,
 * so the advice an agent receives is the advice a human would have read.
 *
 * Only rules that actually fired carry guidance into the payload. A sidecar
 * that reprints all eleven blocks on every clean run teaches the reader to
 * skip them.
 */

import { GUIDANCE } from "./eslint-guidance.js";

function relative(filePath) {
  return filePath.replace(`${process.cwd()}/`, "");
}

/**
 * ESLint's own result minus `source`, which carries the whole file and is by
 * far the largest field in the payload.
 */
function file(result) {
  return {
    filePath: relative(result.filePath),
    errorCount: result.errorCount,
    warningCount: result.warningCount,
    messages: result.messages.map((message) => ({
      ruleId: message.ruleId,
      severity: message.severity,
      message: message.message,
      line: message.line,
      column: message.column,
    })),
  };
}

function triggeredRules(files) {
  const fired = new Set(files.flatMap((entry) => entry.messages.map((message) => message.ruleId)));

  return [...fired]
    .filter((ruleId) => ruleId !== null && ruleId in GUIDANCE)
    .sort()
    .map((ruleId) => ({ ruleId, guidance: GUIDANCE[ruleId] }));
}

function total(files, key) {
  return files.reduce((sum, entry) => sum + entry[key], 0);
}

export default function sensorFormatter(results) {
  const files = results.filter((result) => result.messages.length > 0).map(file);

  return JSON.stringify({
    files,
    summary: {
      totalErrors: total(files, "errorCount"),
      totalWarnings: total(files, "warningCount"),
      triggeredRules: triggeredRules(files),
    },
  });
}

/**
 * Local rules, defined here rather than in a package because they serve this
 * repository alone and are not worth a dependency. Consumed as an inline plugin
 * from `eslint.config.js`.
 */

/** Past this the answer is to refactor, not to loosen the sensor. */
const COMPLEXITY_CEILING = 7;

const RAISES_COMPLEXITY = /^\s*eslint\s+complexity:\s*\[\s*["'](?:warn|error)["']\s*,\s*(\d+)/;

/**
 * ESLint accepts any value in an inline rule override. Without this rule,
 * `/* eslint complexity: ["warn", 20] *\/` switches the sensor off in practice.
 */
const complexityCeiling = {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      tooHigh:
        "Raising complexity to {{ asked }} is not allowed. The ceiling is {{ ceiling }}: past that, extract the branches into named functions instead of loosening the sensor.",
    },
  },
  create(context) {
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          const match = RAISES_COMPLEXITY.exec(comment.value);
          if (match && Number(match[1]) > COMPLEXITY_CEILING) {
            context.report({
              node: comment,
              messageId: "tooHigh",
              data: { asked: match[1], ceiling: String(COMPLEXITY_CEILING) },
            });
          }
        }
      },
    };
  },
};

const DISABLE_DIRECTIVE = /^\s*eslint-disable(?:-next-line|-line)?\b/;

/**
 * A suppression with no reason is indistinguishable from giving up. The article
 * designs suppression as a legitimate exit precisely because it stays visible in
 * the diff, and visible without an explanation is not enough.
 */
const requireDisableReason = {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      noReason:
        "Suppressing a rule requires a justification. Write `-- reason` at the end of the directive, explaining why the rule is wrong here.",
    },
  },
  create(context) {
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          if (DISABLE_DIRECTIVE.test(comment.value) && !comment.value.includes("--")) {
            context.report({ node: comment, messageId: "noReason" });
          }
        }
      },
    };
  },
};

export const localRules = {
  rules: {
    "complexity-ceiling": complexityCeiling,
    "require-disable-reason": requireDisableReason,
  },
};

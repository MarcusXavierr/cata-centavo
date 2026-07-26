import tseslint from "typescript-eslint";
import { localRules } from "./tools/eslint-local-rules.js";

/**
 * Sensors from "Sensors for coding agents" (Martin Fowler, 2026). They are
 * `warn` on purpose: they inform, they do not cancel. The thresholds come from
 * the code's actual distribution rather than from taste. See the design
 * document.
 *
 * `skipComments` is mandatory. Without it the sensor punishes the ADR-citing
 * docblock style that CLAUDE.md requires.
 */
const SENSORS = {
  complexity: ["warn", 6],
  "max-lines-per-function": ["warn", { max: 50, skipComments: true, skipBlankLines: true }],
  "max-params": ["warn", 4],
  "max-depth": ["warn", 3],
  "max-statements": ["warn", 16],
  "max-lines": ["warn", { max: 250, skipComments: true, skipBlankLines: true }],
};

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**"] },

  {
    files: ["**/*.ts"],
    extends: [...tseslint.configs.recommended],
    plugins: { local: localRules },
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      ...SENSORS,
      "@typescript-eslint/no-floating-promises": [
        "error",
        {
          allowForKnownSafeCalls: [
            { from: "package", package: "node:test", name: ["describe", "it", "test", "suite"] },
          ],
        },
      ],
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "no-console": "error",
      "no-restricted-properties": ["error", {
        object: "process",
        property: "stdout",
        message: "stdout is the JSON-RPC channel (ADR §4). Human-facing output goes to stderr.",
      }],
      /**
       * Preference, not a correctness rule: `if` reads better than a ternary
       * in the large majority of cases here. `warn` so the rare justified
       * ternary can stay with `// eslint-disable-line no-restricted-syntax -- reason`
       * (enforced by `local/require-disable-reason`) instead of being banned outright.
       */
      "no-restricted-syntax": ["warn", {
        selector: "ConditionalExpression",
        message: "Prefer `if` over the ternary operator. If this is one of the legitimate exceptions, suppress with a reason instead of leaving it unexplained.",
      }],
      "local/complexity-ceiling": "error",
      "local/require-disable-reason": "error",
    },
  },

  {
    files: ["tests/**/*.ts"],
    rules: {
      "max-lines-per-function": "off",
      complexity: "off",
      "max-statements": "off",
      "max-lines": "off",
    },
  },
);

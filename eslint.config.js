import tseslint from "typescript-eslint";
import { localRules } from "./tools/eslint-local-rules.js";

/**
 * Sensores do artigo "Sensors for coding agents" (Martin Fowler, 2026). São
 * `warn` de propósito: informam, não cancelam. Os limites saíram da distribuição
 * real do código, não de gosto — ver o documento de design.
 *
 * `skipComments` é obrigatório. Sem ele o sensor pune o estilo de docblock com
 * referência de ADR que o CLAUDE.md exige.
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
      "local/complexity-ceiling": "error",
      "local/require-disable-reason": "error",
    },
  },

  {
    files: ["src/core/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: ["**/pluggy/**", "**/storage/**", "**/mcp/**", "pluggy-sdk"] },
      ],
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

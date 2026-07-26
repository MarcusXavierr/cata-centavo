import { describe, it } from "node:test";
import { RuleTester } from "eslint";

import { localRules } from "../../tools/eslint-local-rules.js";

RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester();

describe("complexity-ceiling", () => {
  tester.run("complexity-ceiling", localRules.rules["complexity-ceiling"], {
    valid: [
      { code: "const a = 1;" },
      { code: '/* eslint complexity: ["warn", 7] */\nconst a = 1;' },
      { code: '/* eslint complexity: ["error", 6] */\nconst a = 1;' },
      { code: "// eslint-disable-next-line complexity -- reason\nconst a = 1;" },
    ],
    invalid: [
      {
        code: '/* eslint complexity: ["warn", 8] */\nconst a = 1;',
        errors: [{ messageId: "tooHigh" }],
      },
      {
        code: '/* eslint complexity: ["error", 12] */\nconst a = 1;',
        errors: [{ messageId: "tooHigh" }],
      },
    ],
  });
});

describe("require-disable-reason", () => {
  tester.run("require-disable-reason", localRules.rules["require-disable-reason"], {
    valid: [
      { code: "const a = 1;" },
      { code: "// eslint-disable-next-line complexity -- factory, complexity is incidental\nconst a = 1;" },
      { code: "/* eslint-disable no-console -- diagnostic script */\nconst a = 1;" },
      { code: '/* eslint complexity: ["warn", 7] */\nconst a = 1;' },
    ],
    invalid: [
      {
        code: "// eslint-disable-next-line complexity\nconst a = 1;",
        errors: [{ messageId: "noReason" }],
      },
      {
        code: "/* eslint-disable no-console */\nconst a = 1;",
        errors: [{ messageId: "noReason" }],
      },
    ],
  });
});

/**
 * Regras locais, definidas aqui em vez de num pacote porque servem só a este
 * repositório e não valem uma dependência. Consumidas como plugin inline no
 * `eslint.config.js`.
 */

/** Acima disto a resposta é refatorar, não afrouxar o sensor. */
const COMPLEXITY_CEILING = 7;

const RAISES_COMPLEXITY = /^\s*eslint\s+complexity:\s*\[\s*["'](?:warn|error)["']\s*,\s*(\d+)/;

/**
 * O ESLint aceita qualquer valor num override inline de regra. Sem esta regra,
 * `/* eslint complexity: ["warn", 20] *\/` desliga o sensor na prática.
 */
const complexityCeiling = {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      tooHigh:
        "Subir a complexidade para {{ asked }} não é permitido. O teto é {{ ceiling }}: acima disso, extraia os ramos em funções nomeadas em vez de afrouxar o sensor.",
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
 * Uma supressão sem motivo é indistinguível de desistência. O artigo desenha a
 * supressão como saída legítima justamente porque ela fica visível no diff —
 * visível e sem explicação não serve.
 */
const requireDisableReason = {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      noReason:
        "Suprimir uma regra exige justificativa. Escreva `-- motivo` no fim da diretiva, explicando por que a regra está errada aqui.",
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

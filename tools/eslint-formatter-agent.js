/**
 * Formatter que agrupa por regra em vez de por arquivo, e anexa orientação
 * acionável a cada uma.
 *
 * A inversão é o ponto: quem lê vê "complexidade estourou em três lugares, eis
 * o que fazer com complexidade" em vez de três arquivos com uma linha críptica
 * cada. Ver "Sensors for coding agents" (Martin Fowler, 2026) e o documento de
 * design em docs/plans/2026-07-26-eslint-e-logging-design.md.
 *
 * Regra ausente do mapa cai na mensagem padrão do ESLint, então acrescentar
 * regra nunca quebra este arquivo.
 */

const GUIDANCE = {
  complexity: `Ramificação demais numa função só. Extraia os ramos em funções nomeadas
e teste cada uma — o CLAUDE.md já pede isso ("se um comentário é
necessário para explicar uma seção, aquela seção é uma função").

Se a refatoração não compensar, há duas saídas, ambas visíveis no diff:
  /* eslint complexity: ["warn", 7] */                 (teto é 7)
  // eslint-disable-next-line complexity -- (motivo)`,

  "max-lines-per-function": `Função longa demais para caber na cabeça de quem lê. Procure o ponto
onde ela muda de assunto e corte ali.

Factory que monta e devolve um objeto costuma ser exceção legítima:
  // eslint-disable-next-line max-lines-per-function -- (motivo)`,

  "max-lines": `Arquivo grande demais. Normalmente ele está fazendo duas coisas —
separe pela que tem menos dependências com o resto.`,

  "max-params": `Parâmetros demais. Agrupe os relacionados num objeto nomeado, que
também elimina a chance de trocar a ordem de dois do mesmo tipo.`,

  "max-depth": `Aninhamento fundo. Inverta as condições e retorne cedo, ou extraia o
bloco interno para uma função nomeada.`,

  "max-statements": `Passos demais numa função. Costuma sair barato agrupar os passos que
compartilham variáveis e dar um nome ao grupo.`,

  "@typescript-eslint/no-explicit-any": `\`any\` desliga a verificação de tipo justamente onde ela protegeria.
Prefira \`unknown\` e estreite com uma checagem, que o compilador cobra.

Faça o julgamento: se o tipo não existe de verdade, suprima com motivo.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- (motivo)`,

  "@typescript-eslint/no-floating-promises": `Promise sem \`await\`, \`.catch\` ou \`void\` explícito. A rejeição some, e
neste projeto o que some costuma ser dinheiro que não foi paginado.`,

  "no-console": `\`console\` escreve em stdout, e em modo servidor stdout é o canal
JSON-RPC (ADR §4). Uma linha aqui corrompe o protocolo.

Use o \`Logger\` injetado, ou \`say()\` em src/bin/ para texto de humano.`,

  "no-restricted-imports": `\`src/core/\` não importa de \`pluggy/\`, \`storage/\` nem \`mcp/\` (ADR §6). O
contrato pertence a quem consome: declare o que você precisa como tipo em
\`core/contracts.ts\` e receba a implementação por parâmetro.`,

  "local/complexity-ceiling": `O teto de 7 é deliberado. Acima disso a resposta é extrair funções.`,

  "local/require-disable-reason": `Supressão sem motivo é indistinguível de desistência. Escreva o
\`-- motivo\` explicando por que a regra está errada neste ponto.`,
};

const SEVERITY = { 1: "aviso", 2: "erro" };

function relative(filePath) {
  return filePath.replace(`${process.cwd()}/`, "");
}

function groupByRule(results) {
  const groups = new Map();

  for (const result of results) {
    for (const message of result.messages) {
      const rule = message.ruleId ?? "(erro de parsing)";
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
  const plural = group.entries.length === 1 ? "ocorrência" : "ocorrências";
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
    `${errors} ${errors === 1 ? "erro" : "erros"} (reprovam o build), ` +
    `${warnings} ${warnings === 1 ? "aviso" : "avisos"} (não reprovam).`;

  return ["", ...groups.map(renderGroup), footer, ""].join("\n");
}

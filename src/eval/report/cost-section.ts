import type { VariantSummary } from "../../core/index.js";
import { formatMoney } from "../../shared/index.js";

const tick = (text: string): string => `\`${text}\``;
const count = (n: number): string => Math.round(n).toLocaleString("en-US");

/** A row of a Markdown table. Pipes in a cell would split it, so they are escaped. */
const row = (cells: readonly string[]): string =>
  `| ${cells.map((c) => c.replace(/\|/g, "\\|")).join(" | ")} |`;

function table(header: readonly string[], rows: readonly (readonly string[])[]): string[] {
  return [row(header), row(header.map(() => "---")), ...rows.map(row)];
}

/**
 * What each variant cost per 100 questions, from every model and embedder call made to answer them
 * (not only the final answer).
 *
 * Money appears only for models with a price in the config. The tokens of the others are counted and
 * named, so a forgotten price cannot pass for a free model. The judge is listed on its own: it
 * measures the system and is not part of what the system costs.
 *
 * Empty when no variant recorded any usage (a run made before RAG-093).
 */
export function costSection(ran: readonly VariantSummary[]): string[] {
  const withCost = ran.filter((v) => v.cost !== undefined);
  if (withCost.length === 0) return [];

  const priced = withCost.some((v) => (v.cost?.currency ?? "") !== "" && (v.cost?.total ?? 0) > 0);
  const unpriced = withCost.reduce((sum, v) => sum + (v.cost?.unpricedTokens ?? 0), 0);
  const currency = withCost.find((v) => (v.cost?.currency ?? "") !== "")?.cost?.currency ?? "";
  const questions = (v: VariantSummary): number =>
    Math.max(1, v.questions.total - v.questions.failed);

  const lines: string[] = ["### Cost per 100 questions", ""];
  lines.push(
    "Every model and embedder call made to answer the questions counts: the answer, and also rewriting, reranking and embedding the question. " +
      (priced
        ? `Money is in ${currency}, from the ${tick("pricing")} table of the config.`
        : `No price is set for these models, so no money is shown (local models are free; for a hosted model add its price under ${tick("pricing")} in the config).`),
    "",
    ...table(
      [
        "variant",
        ...(priced ? [`cost per 100 (${currency})`] : []),
        "model calls per question",
        "tokens in per question",
        "tokens out per question",
        "model time per question (ms)",
      ],
      withCost.map((v) => {
        const c = v.cost as NonNullable<VariantSummary["cost"]>;
        const n = questions(v);
        return [
          tick(v.variant),
          ...(priced ? [formatMoney(c.per100Questions)] : []),
          (c.calls / n).toFixed(1),
          count(c.promptTokens / n),
          count(c.outputTokens / n),
          count(c.modelMs / n),
        ];
      }),
    ),
    "",
  );
  if (priced && unpriced > 0) {
    lines.push(
      `${count(unpriced)} tokens belong to models with no price, so the money above leaves them out.`,
      "",
    );
  }

  const judged = withCost.filter((v) => v.cost?.judge !== undefined);
  if (judged.length > 0) {
    lines.push(
      "The judge, apart from the system:",
      "",
      ...table(
        [
          "variant",
          ...(priced ? [`judge cost per 100 (${currency})`] : []),
          "judge calls",
          "judge tokens in",
          "judge tokens out",
        ],
        judged.map((v) => {
          const j = v.cost?.judge as NonNullable<NonNullable<VariantSummary["cost"]>["judge"]>;
          return [
            tick(v.variant),
            ...(priced ? [formatMoney(j.per100Questions)] : []),
            count(j.calls),
            count(j.promptTokens),
            count(j.outputTokens),
          ];
        }),
      ),
      "",
    );
  }
  return lines;
}

import type { ExperimentSummary, VariantSummary } from "../core/index.js";
import type { ExperimentPlan } from "./build-experiment.js";

const num = (value: number | undefined): string => (value === undefined ? "-" : value.toFixed(2));
const ms = (value: number | undefined): string =>
  value === undefined ? "-" : Math.round(value).toString();

function row(cells: readonly string[], widths: readonly number[]): string {
  return cells
    .map((cell, i) => (i === 0 ? cell.padEnd(widths[i] ?? 0) : cell.padStart(widths[i] ?? 0)))
    .join("  ")
    .trimEnd();
}

function table(header: readonly string[], rows: readonly (readonly string[])[]): string[] {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  return [row(header, widths), ...rows.map((r) => row(r, widths))];
}

/** The plan as `pnpm experiment --dry-run` prints it: what would run, nothing started. */
export function describePlan(plan: ExperimentPlan, location: string): string {
  return [
    `Experiment ${plan.name}${plan.description === undefined ? "" : `: ${plan.description}`}`,
    `Dataset ${plan.dataset} (${plan.datasetVersion}), ${plan.questions.toString()} questions, ` +
      (plan.generation ? "answers generated and judged" : "retrieval only"),
    `Results would go to ${location}`,
    "",
    `${plan.variants.length.toString()} variants:`,
    ...plan.variants.map((v) => `  ${v.name}`),
  ].join("\n");
}

/**
 * The summary as a table, one row per variant, for the end of `pnpm experiment`. The numbers are
 * the means of `summary.json`; the report of RAG-084 reads the same file.
 */
export function describeSummary(summary: ExperimentSummary, location: string): string {
  const ran = summary.variants.filter((v) => v.error === undefined);
  const failed = summary.variants.filter((v) => v.error !== undefined);
  const withGeneration = summary.generation;

  const header = [
    "variant",
    "k",
    "hit",
    "prec",
    "recall",
    "mrr",
    "ndcg",
    ...(withGeneration ? ["faith", "relev", "correct"] : []),
    "refused",
    "p50ms",
    "p95ms",
    "failed",
  ];
  const rows = ran.map((v: VariantSummary) => [
    v.variant,
    v.k.toString(),
    num(v.retrieval?.hit),
    num(v.retrieval?.precision),
    num(v.retrieval?.recall),
    num(v.retrieval?.mrr),
    num(v.retrieval?.ndcg),
    ...(withGeneration
      ? [
          num(v.generation?.faithfulness),
          num(v.generation?.relevance),
          num(v.generation?.correctness),
        ]
      : []),
    // unanswerable questions refused out of all unanswerable ones: higher is better
    v.questions.unanswerable === 0
      ? "-"
      : `${v.refusals.unanswerableRefused.toString()}/${v.questions.unanswerable.toString()}`,
    ms(v.latencyMs.retrievalP50),
    ms(v.latencyMs.retrievalP95),
    v.questions.failed.toString(),
  ]);

  return [
    `Experiment ${summary.experiment}: ${summary.variants.length.toString()} variants, dataset ${summary.datasetVersion}` +
      (summary.gitCommit === null ? "" : `, commit ${summary.gitCommit.slice(0, 7)}`),
    "",
    ...(rows.length === 0 ? ["No variant ran."] : table(header, rows)),
    ...(failed.length === 0
      ? []
      : ["", "Could not run:", ...failed.map((v) => `  ${v.variant}: ${v.error ?? ""}`)]),
    "",
    `Results: ${location}`,
  ].join("\n");
}

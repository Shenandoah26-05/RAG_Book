import type { ExperimentSummary, QuestionResult, VariantSummary } from "../../core/index.js";
import { RagError } from "../../shared/index.js";
import { compareVariants, METRICS } from "./compare.js";
import type { MetricName, QuestionComparison, VariantComparison } from "./compare.js";

export interface ReportInput {
  readonly summary: ExperimentSummary;
  readonly results: readonly QuestionResult[];
  /** The config each variant ran with, by variant name, so the report is self-contained. */
  readonly configs?: Readonly<Record<string, unknown>>;
  /** The variant everything is compared with. Default: the first that ran. */
  readonly baseline?: string;
  /** What variants are ranked and compared by. Default: nDCG, or correctness without retrieval. */
  readonly metric?: MetricName;
  /** How many of the biggest wins and losses to list per variant. Default 5. */
  readonly top?: number;
  /** Where the raw files are, so a reader can go from the report to the data. */
  readonly source?: string;
}

const fixed = (value: number | undefined, digits = 2): string =>
  value === undefined ? "-" : value.toFixed(digits);
const signed = (value: number): string => `${value >= 0 ? "+" : "-"}${Math.abs(value).toFixed(2)}`;
const ms = (value: number | undefined): string =>
  value === undefined ? "-" : Math.round(value).toLocaleString("en-US");
const tick = (text: string): string => `\`${text}\``;

/** A row of a Markdown table. Pipes in a cell would split it, so they are escaped. */
const row = (cells: readonly string[]): string =>
  `| ${cells.map((c) => c.replace(/\|/g, "\\|")).join(" | ")} |`;

function table(header: readonly string[], rows: readonly (readonly string[])[]): string[] {
  return [row(header), row(header.map(() => "---")), ...rows.map(row)];
}

/** The value of a metric for a variant, from its summary. */
function metricOf(variant: VariantSummary, metric: MetricName): number | undefined {
  switch (metric) {
    case "ndcg":
    case "mrr":
    case "recall":
    case "hit":
    case "precision":
      return variant.retrieval?.[metric];
    case "correctness":
    case "faithfulness":
    case "relevance":
      return variant.generation?.[metric];
  }
}

/** Marks the best value of a column in bold. Equal best values are all marked. */
function boldBest(values: readonly (number | undefined)[], digits = 2): string[] {
  const best = Math.max(...values.filter((v): v is number => v !== undefined));
  return values.map((v) =>
    v === undefined ? "-" : v === best ? `**${v.toFixed(digits)}**` : v.toFixed(digits),
  );
}

const VERDICT_WORDS = {
  better: "better",
  worse: "worse",
  unclear: "no clear difference",
} as const;

function listChanges(
  heading: string,
  changes: readonly QuestionComparison[],
  kinds: ReadonlyMap<string, string>,
): string[] {
  if (changes.length === 0) return [`${heading}: none.`, ""];
  return [
    `${heading}:`,
    "",
    ...table(
      ["question", "kind", "baseline", "variant", "change"],
      changes.map((q) => [
        tick(q.questionId),
        kinds.get(q.questionId) ?? "-",
        fixed(q.baseline),
        fixed(q.variant),
        signed(q.difference),
      ]),
    ),
    "",
  ];
}

/**
 * Turns the results of an experiment into a Markdown report that can be read, argued with and
 * cited by a decision.
 *
 * It is written to avoid over-reading. A mean can be higher by luck, so every variant is compared
 * with the baseline question by question, and the verdict ("better", "worse", "no clear
 * difference") comes from a bootstrap interval of the difference, not from which mean is bigger.
 * With a few dozen questions most verdicts will be "no clear difference", and the report says so.
 * The caveats are generated from the data (few questions, failures, different cutoffs), and the
 * full config of every variant is included, so a report saved with a decision still says exactly
 * what was compared.
 *
 * @throws RagError INVALID_ARGUMENT if no variant ran, or the baseline or metric cannot be used
 */
export function renderReport(input: ReportInput): string {
  const { summary, results, configs = {}, top = 5 } = input;
  const ran = summary.variants.filter((v) => v.error === undefined);
  const failed = summary.variants.filter((v) => v.error !== undefined);
  if (ran.length === 0) {
    throw new RagError("INVALID_ARGUMENT", "No variant ran, so there is nothing to report");
  }

  const metric: MetricName =
    input.metric ?? (ran.some((v) => v.retrieval !== undefined) ? "ndcg" : "correctness");
  if (!ran.some((v) => metricOf(v, metric) !== undefined)) {
    throw new RagError(
      "INVALID_ARGUMENT",
      `No variant has a ${METRICS[metric].label} score. ${
        metric === "ndcg" ||
        metric === "mrr" ||
        metric === "recall" ||
        metric === "hit" ||
        metric === "precision"
          ? "The experiment has no answerable questions that ran."
          : 'The experiment did not generate answers: set "generation": true.'
      }`,
    );
  }
  const baselineName = input.baseline ?? (ran[0] as VariantSummary).variant;
  if (!ran.some((v) => v.variant === baselineName)) {
    throw new RagError(
      "INVALID_ARGUMENT",
      `The baseline "${baselineName}" is not a variant that ran. Variants: ${ran.map((v) => v.variant).join(", ")}`,
    );
  }

  const label = METRICS[metric].label;
  const kinds = new Map(results.map((r) => [r.questionId, r.kind]));
  const ranked = [...ran].sort((a, b) => (metricOf(b, metric) ?? -1) - (metricOf(a, metric) ?? -1));
  const others = ran.filter((v) => v.variant !== baselineName);
  const comparisons = new Map<string, VariantComparison>(
    others.map((v) => [v.variant, compareVariants(results, baselineName, v.variant, metric)]),
  );
  const baseline = ran.find((v) => v.variant === baselineName) as VariantSummary;
  const withGeneration = ran.some((v) => v.generation !== undefined);

  const lines: string[] = [];
  const add = (...more: string[]): void => {
    lines.push(...more);
  };

  // ---- header ----
  add(
    `# Experiment ${summary.experiment}: A/B report`,
    "",
    ...(summary.description === undefined ? [] : [`> ${summary.description}`, ""]),
    ...table(
      ["", ""],
      [
        ["Dataset", `${tick(summary.dataset)} (version ${summary.datasetVersion})`],
        [
          "Questions",
          `${baseline.questions.total.toString()} (${baseline.questions.answerable.toString()} answerable, ${baseline.questions.unanswerable.toString()} unanswerable)`,
        ],
        ["Code", summary.gitCommit === null ? "not in a git repository" : tick(summary.gitCommit)],
        ["Run", `${summary.startedAt} to ${summary.finishedAt}`],
        ["Answers", summary.generation ? "generated and judged" : "not generated (retrieval only)"],
        ["Baseline", tick(baselineName)],
        ["Ranked by", `${label}, higher is better`],
        ...(input.source === undefined ? [] : [["Raw data", tick(input.source)]]),
      ],
    ),
    "",
  );

  // ---- summary ----
  const best = ranked[0] as VariantSummary;
  add("## Summary", "");
  add(
    `On ${label}, ${tick(best.variant)} scores highest (${fixed(metricOf(best, metric))})` +
      (best.variant === baselineName
        ? ", and that is the baseline."
        : `, against ${fixed(metricOf(baseline, metric))} for the baseline ${tick(baselineName)}.`),
    "",
  );
  if (others.length === 0) {
    add("Only one variant ran, so there is nothing to compare it with.", "");
  } else {
    for (const variant of others) {
      const c = comparisons.get(variant.variant) as VariantComparison;
      add(
        `- ${tick(variant.variant)} is **${VERDICT_WORDS[c.verdict]}** than the baseline on ${label}` +
          (c.verdict === "unclear" ? " (the difference could be chance)" : "") +
          `: ${signed(c.meanDifference)}` +
          (c.interval === undefined
            ? ""
            : `, 95% interval [${signed(c.interval.low)}, ${signed(c.interval.high)}]`) +
          `; ${c.wins.toString()} questions better, ${c.losses.toString()} worse, ${c.ties.toString()} the same.`,
      );
    }
    add("");
    if (others.every((v) => comparisons.get(v.variant)?.verdict === "unclear")) {
      add(
        "**No variant is clearly different from the baseline.** The differences between the means are " +
          "within what chance alone could produce with this many questions. Do not choose between them on " +
          "this evidence; prefer the simpler or cheaper one, or add questions.",
        "",
      );
    }
  }

  // ---- metrics ----
  add("## Metrics per variant", "");
  add(
    `Means over the answerable questions that ran. Best in each column in bold. ${tick("k")} is how many chunks the variant retrieves.`,
    "",
  );
  const columns: { header: string; read: (v: VariantSummary) => number | undefined }[] = [
    { header: "hit", read: (v) => v.retrieval?.hit },
    { header: "precision", read: (v) => v.retrieval?.precision },
    { header: "recall", read: (v) => v.retrieval?.recall },
    { header: "MRR", read: (v) => v.retrieval?.mrr },
    { header: "nDCG", read: (v) => v.retrieval?.ndcg },
    ...(withGeneration
      ? [
          { header: "faithfulness", read: (v: VariantSummary) => v.generation?.faithfulness },
          { header: "relevance", read: (v: VariantSummary) => v.generation?.relevance },
          { header: "correctness", read: (v: VariantSummary) => v.generation?.correctness },
        ]
      : []),
  ];
  const cells = columns.map((c) => boldBest(ranked.map(c.read)));
  add(
    ...table(
      ["variant", "k", ...columns.map((c) => c.header), "failed"],
      ranked.map((v, i) => [
        tick(v.variant) + (v.variant === baselineName ? " (baseline)" : ""),
        v.k.toString(),
        ...cells.map((column) => column[i] ?? "-"),
        v.questions.failed.toString(),
      ]),
    ),
    "",
  );

  // ---- against the baseline ----
  if (others.length > 0) {
    add("## Against the baseline", "");
    add(
      `Each variant is compared with ${tick(baselineName)} on the same questions, by ${label}. A *win* is a question where the variant scored higher. ` +
        'The interval is a 95% bootstrap interval of the mean difference; the verdict is "better" or "worse" only when it excludes 0.',
      "",
    );
    add(
      ...table(
        ["variant", "wins", "losses", "same", "mean change", "95% interval", "verdict"],
        others.map((v) => {
          const c = comparisons.get(v.variant) as VariantComparison;
          return [
            tick(v.variant),
            c.wins.toString(),
            c.losses.toString(),
            c.ties.toString(),
            signed(c.meanDifference),
            c.interval === undefined
              ? "-"
              : `[${signed(c.interval.low)}, ${signed(c.interval.high)}]`,
            VERDICT_WORDS[c.verdict],
          ];
        }),
      ),
      "",
    );
    for (const variant of others) {
      const c = comparisons.get(variant.variant) as VariantComparison;
      const gains = c.questions
        .filter((q) => q.outcome === "win")
        .sort((a, b) => b.difference - a.difference)
        .slice(0, top);
      const drops = c.questions
        .filter((q) => q.outcome === "loss")
        .sort((a, b) => a.difference - b.difference)
        .slice(0, top);
      add(`### ${tick(variant.variant)}`, "");
      add(...listChanges(`Biggest wins (up to ${top.toString()})`, gains, kinds));
      add(...listChanges(`Biggest losses (up to ${top.toString()})`, drops, kinds));
    }
  }

  // ---- latency and cost ----
  add("## Latency and token cost", "");
  add(
    "Latency is per question, in milliseconds, from one run on one machine: compare the variants with each other, not with other runs. " +
      "Tokens are the model's own counts, summed over the run; the local models cost no money, but tokens are time.",
    "",
  );
  add(
    ...table(
      [
        "variant",
        "retrieval p50",
        "retrieval p95",
        ...(summary.generation ? ["generation p50", "generation p95"] : []),
        "prompt tokens",
        "output tokens",
        "tokens per question",
        "index",
      ],
      ran.map((v) => {
        const answered = Math.max(1, v.questions.total - v.questions.failed);
        return [
          tick(v.variant),
          ms(v.latencyMs.retrievalP50),
          ms(v.latencyMs.retrievalP95),
          ...(summary.generation
            ? [ms(v.latencyMs.generationP50), ms(v.latencyMs.generationP95)]
            : []),
          v.tokens.prompt.toLocaleString("en-US"),
          v.tokens.output.toLocaleString("en-US"),
          Math.round((v.tokens.prompt + v.tokens.output) / answered).toLocaleString("en-US"),
          `${v.index.status} (${v.index.namespace})`,
        ];
      }),
    ),
    "",
  );

  // ---- refusals ----
  add("## Refusals", "");
  add(
    "A good system refuses the unanswerable questions and answers the rest.",
    "",
    ...table(
      ["variant", "unanswerable refused", "answerable refused"],
      ran.map((v) => [
        tick(v.variant),
        v.questions.unanswerable === 0
          ? "-"
          : `${v.refusals.unanswerableRefused.toString()} of ${v.questions.unanswerable.toString()}`,
        `${v.refusals.answerableRefused.toString()} of ${v.questions.answerable.toString()}`,
      ]),
    ),
    "",
  );

  // ---- caveats ----
  const caveats: string[] = [];
  const answerable = baseline.questions.answerable;
  if (answerable < 100) {
    caveats.push(
      `Only ${answerable.toString()} answerable questions. Small gaps between variants are within noise; ` +
        "the intervals above show how much.",
    );
  }
  if (new Set(ran.map((v) => v.k)).size > 1) {
    caveats.push(
      "The variants retrieve different numbers of chunks (`k`). Precision and recall at different cutoffs are not directly comparable.",
    );
  }
  const withFailures = ran.filter((v) => v.questions.failed > 0);
  if (withFailures.length > 0) {
    caveats.push(
      `Questions failed for ${withFailures.map((v) => tick(v.variant)).join(", ")}. They are left out of the means, so those variants were measured on fewer questions.`,
    );
  }
  if (failed.length > 0) {
    caveats.push(
      `${failed.length.toString()} variant(s) could not run and are not in the tables: ${failed.map((v) => `${tick(v.variant)} (${v.error ?? "unknown error"})`).join("; ")}.`,
    );
  }
  if (withGeneration) {
    caveats.push(
      "Generation scores come from a small local language model acting as judge. They rank variants reasonably but are not absolute quality, and the judge may favour longer or more confident answers.",
    );
  } else {
    caveats.push(
      "No answers were generated, so this report says which variant *finds* the right passages, not which writes the best answer.",
    );
  }
  caveats.push(
    "One run per variant: nothing here says how much a score moves between runs. Retrieval is deterministic for a given index; generation is not.",
  );
  add("## Caveats", "", ...caveats.map((c) => `- ${c}`), "");

  // ---- configs ----
  add("## Configs", "");
  add(
    "Everything needed to repeat each variant. A decision that cites this report cites these configs; the hash is `hashConfig` of the effective configuration.",
    "",
  );
  for (const v of summary.variants) {
    add(`### ${tick(v.variant)}`, "");
    if (v.error !== undefined) {
      add(`Could not run: ${v.error}`, "");
    }
    add(
      ...table(
        ["", ""],
        [
          ["Config hash", tick(v.configHash === "" ? "(not built)" : v.configHash)],
          ["Config file", v.configFile === "" ? "-" : tick(v.configFile)],
          ["Changes from the base", tick(JSON.stringify(v.settings))],
          ["Embedder", tick(v.models.embedder === "" ? "-" : v.models.embedder)],
          ["Generator", tick(v.models.generator === "" ? "-" : v.models.generator)],
          ...(v.models.judge === undefined ? [] : [["Judge", tick(v.models.judge)]]),
        ],
      ),
      "",
    );
    const config = configs[v.variant];
    if (config !== undefined) {
      add("```json", JSON.stringify(config, null, 2), "```", "");
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

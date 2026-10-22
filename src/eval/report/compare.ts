import type { QuestionResult } from "../../core/index.js";
import { RagError } from "../../shared/index.js";

/** The measures a report can rank variants by, and how to read each from one result. */
export const METRICS = {
  ndcg: { label: "nDCG", read: (r: QuestionResult) => r.retrieval?.ndcg },
  mrr: { label: "MRR", read: (r: QuestionResult) => r.retrieval?.mrr },
  recall: { label: "recall", read: (r: QuestionResult) => r.retrieval?.recall },
  hit: { label: "hit", read: (r: QuestionResult) => r.retrieval?.hit },
  precision: { label: "precision", read: (r: QuestionResult) => r.retrieval?.precision },
  correctness: { label: "correctness", read: (r: QuestionResult) => r.generation?.correctness },
  faithfulness: { label: "faithfulness", read: (r: QuestionResult) => r.generation?.faithfulness },
  relevance: { label: "relevance", read: (r: QuestionResult) => r.generation?.relevance },
} as const;
export type MetricName = keyof typeof METRICS;

export const METRIC_NAMES = Object.keys(METRICS) as MetricName[];
export const isMetricName = (value: string): value is MetricName => Object.hasOwn(METRICS, value);

/** Differences smaller than this are ties; scores are sums of small fractions, so not exactly equal. */
const TIE = 1e-9;

export type Outcome = "win" | "loss" | "tie";

/** One question, a variant against the baseline. */
export interface QuestionComparison {
  readonly questionId: string;
  readonly baseline: number;
  readonly variant: number;
  /** `variant - baseline`: positive means the variant did better. */
  readonly difference: number;
  readonly outcome: Outcome;
}

/** A variant against the baseline on one metric. */
export interface VariantComparison {
  readonly variant: string;
  readonly metric: MetricName;
  /** The questions both variants have a score for, in dataset order. */
  readonly questions: readonly QuestionComparison[];
  readonly wins: number;
  readonly losses: number;
  readonly ties: number;
  /** Mean of the differences. */
  readonly meanDifference: number;
  /** 95% confidence interval of the mean difference (paired bootstrap). Absent with fewer than 2 questions. */
  readonly interval?: { readonly low: number; readonly high: number };
  /**
   * What the evidence supports. "better" or "worse" only when the interval excludes 0; with this few
   * questions most differences will read "unclear", which is the honest answer.
   */
  readonly verdict: "better" | "worse" | "unclear";
}

/** A small seeded random number generator (mulberry32), so a report is the same every time. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const mean = (values: readonly number[]): number =>
  values.reduce((sum, v) => sum + v, 0) / values.length;

/** Resamples per bootstrap. Enough for the interval ends to settle to two decimals. */
export const BOOTSTRAP_RESAMPLES = 2000;

/**
 * 95% interval for the mean of paired differences by bootstrap: resample the questions with
 * replacement many times, take the mean each time, and read off the 2.5th and 97.5th percentiles.
 * It makes no assumption about how the scores are distributed, which matters because they are
 * bounded, lumpy (0, 0.5, 1) and few.
 */
export function bootstrapInterval(
  differences: readonly number[],
  seed = 1,
  resamples = BOOTSTRAP_RESAMPLES,
): { readonly low: number; readonly high: number } | undefined {
  if (differences.length < 2) return undefined;
  const random = seeded(seed);
  const n = differences.length;
  const means: number[] = [];
  for (let r = 0; r < resamples; r++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += differences[Math.floor(random() * n)] ?? 0;
    means.push(sum / n);
  }
  means.sort((a, b) => a - b);
  return {
    low: means[Math.floor(0.025 * resamples)] ?? 0,
    high: means[Math.min(resamples - 1, Math.ceil(0.975 * resamples) - 1)] ?? 0,
  };
}

function byQuestion(
  results: readonly QuestionResult[],
  variant: string,
): Map<string, QuestionResult> {
  return new Map(
    results
      .filter((r) => r.variant === variant && r.error === undefined)
      .map((r) => [r.questionId, r]),
  );
}

/**
 * Compares `variant` with `baseline` question by question on one metric. Only questions that both
 * answered without error and that have the metric are compared (an unanswerable question has no
 * retrieval score, and a refused answer has no faithfulness), so the two sides always see the same
 * questions.
 *
 * @throws RagError INVALID_ARGUMENT if either variant has no results
 */
export function compareVariants(
  results: readonly QuestionResult[],
  baseline: string,
  variant: string,
  metric: MetricName,
): VariantComparison {
  const base = byQuestion(results, baseline);
  const other = byQuestion(results, variant);
  for (const [name, found] of [
    [baseline, base],
    [variant, other],
  ] as const) {
    if (found.size === 0 && !results.some((r) => r.variant === name)) {
      throw new RagError("INVALID_ARGUMENT", `No results for variant "${name}"`);
    }
  }

  const read = METRICS[metric].read;
  const questions: QuestionComparison[] = [];
  for (const [questionId, baseResult] of base) {
    const variantResult = other.get(questionId);
    const before = read(baseResult);
    const after = variantResult === undefined ? undefined : read(variantResult);
    if (before === undefined || after === undefined) continue;
    const difference = after - before;
    questions.push({
      questionId,
      baseline: before,
      variant: after,
      difference,
      outcome: difference > TIE ? "win" : difference < -TIE ? "loss" : "tie",
    });
  }

  const differences = questions.map((q) => q.difference);
  const interval = bootstrapInterval(differences);
  return {
    variant,
    metric,
    questions,
    wins: questions.filter((q) => q.outcome === "win").length,
    losses: questions.filter((q) => q.outcome === "loss").length,
    ties: questions.filter((q) => q.outcome === "tie").length,
    meanDifference: differences.length === 0 ? 0 : mean(differences),
    ...(interval === undefined ? {} : { interval }),
    verdict:
      interval === undefined
        ? "unclear"
        : interval.low > 0
          ? "better"
          : interval.high < 0
            ? "worse"
            : "unclear",
  };
}

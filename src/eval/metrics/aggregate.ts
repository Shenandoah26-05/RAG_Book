import { RagError } from "../../shared/index.js";
import type { RetrievalMetrics } from "./metrics.js";

/** The mean of each metric over questions, at one cutoff. `mrr` here is the mean reciprocal rank. */
export interface MeanRetrievalMetrics extends RetrievalMetrics {
  /** How many questions were averaged. */
  readonly questions: number;
}

/**
 * Averages per-question metrics, all taken at the same cutoff (a macro average: every question
 * counts the same, however many gold passages it has). Pass answerable questions only.
 * @throws RagError INVALID_ARGUMENT for no questions, or scores at different cutoffs
 */
export function meanMetrics(scores: readonly RetrievalMetrics[]): MeanRetrievalMetrics {
  const first = scores[0];
  if (first === undefined) {
    throw new RagError("INVALID_ARGUMENT", "There are no questions to average");
  }
  const mixed = scores.find((s) => s.k !== first.k);
  if (mixed !== undefined) {
    throw new RagError(
      "INVALID_ARGUMENT",
      `Cannot average scores at different cutoffs (k = ${first.k.toString()} and k = ${mixed.k.toString()})`,
    );
  }
  const mean = (pick: (s: RetrievalMetrics) => number): number =>
    scores.reduce((sum, s) => sum + pick(s), 0) / scores.length;
  return {
    k: first.k,
    questions: scores.length,
    hit: mean((s) => s.hit),
    precision: mean((s) => s.precision),
    recall: mean((s) => s.recall),
    mrr: mean((s) => s.mrr),
    ndcg: mean((s) => s.ndcg),
  };
}

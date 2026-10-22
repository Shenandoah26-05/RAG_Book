import type { ExperimentSummary, QuestionResult } from "../../core/index.js";
import { RagError } from "../../shared/index.js";
import type { SmokeObservation } from "./baseline.js";

/**
 * What a smoke run measured, taken from an experiment's summary and results: recall@k of each
 * answerable question, and their mean. The mean is computed here from the per-question values, so
 * the numbers in a baseline always agree with each other.
 *
 * A run that did not finish cleanly is an error, not a low score: a question that failed (the model
 * was down, say) has no recall, and counting it as 0 would report a regression that is really an
 * outage.
 *
 * @throws RagError INVALID_ARGUMENT if the experiment has other than one variant, the variant could
 * not be built, a question failed, or there was no answerable question to measure
 */
export function observeSmoke(
  summary: ExperimentSummary,
  results: readonly QuestionResult[],
): SmokeObservation {
  const [variant, ...others] = summary.variants;
  if (variant === undefined || others.length > 0) {
    throw new RagError(
      "INVALID_ARGUMENT",
      `The smoke experiment must have exactly one variant, it has ${summary.variants.length.toString()}`,
    );
  }
  if (variant.error !== undefined) {
    throw new RagError("INVALID_ARGUMENT", `The smoke variant could not run: ${variant.error}`);
  }
  const failed = results.filter((r) => r.error !== undefined);
  if (failed.length > 0) {
    throw new RagError(
      "INVALID_ARGUMENT",
      `${failed.length.toString()} smoke question(s) failed, so there is no score to compare. ` +
        `First: ${failed[0]?.questionId ?? "?"}: ${failed[0]?.error ?? "?"}`,
    );
  }

  const questions: Record<string, number> = {};
  for (const result of results) {
    if (result.retrieval !== undefined) questions[result.questionId] = result.retrieval.recall;
  }
  const recalls = Object.values(questions);
  if (recalls.length === 0) {
    throw new RagError("INVALID_ARGUMENT", "The smoke run has no answerable question to measure");
  }
  return {
    dataset: summary.datasetVersion,
    k: variant.k,
    recall: recalls.reduce((sum, recall) => sum + recall, 0) / recalls.length,
    questions,
    configHash: variant.configHash,
  };
}

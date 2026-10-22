import type { AnswerJudgement, JudgeInput } from "../types/judgement.js";

/**
 * Scores a written answer: is it grounded in the sources, does it address the question, does it
 * match the reference. Retrieval metrics are arithmetic; these need something that reads, so an
 * implementation is usually a language model (`LlmAnswerJudge`).
 *
 * Rules every judge follows:
 * 1. Every score is between 0 and 1. Faithfulness is undefined only when the answer makes no claim.
 * 2. A judge that cannot produce a trustworthy score throws. It never guesses a number: a made-up
 *    score would look like a measurement.
 * 3. A model that cannot be reached is a RagError coded PROVIDER_UNAVAILABLE.
 * 4. Aborting `signal` stops the work and throws the signal's reason.
 */
export interface AnswerJudge {
  /** The model behind the scores, e.g. "ollama:llama3.1". Goes into eval reports. */
  readonly modelId: string;
  judge(input: JudgeInput, signal?: AbortSignal): Promise<AnswerJudgement>;
}

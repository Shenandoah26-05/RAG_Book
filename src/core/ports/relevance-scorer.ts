/**
 * Judges how well passages answer a question, one number per passage. A cross-encoder model reads
 * the question and a passage together and gives a relevance score; an LLM asked to rate a passage
 * is the same shape. A `Reranker` turns these scores into a new order (`ScoringReranker`).
 *
 * Rules every scorer must follow:
 * 1. `score` returns exactly one finite number per passage, in the order the passages were given.
 *    Higher means more relevant. No passages gives an empty list.
 * 2. Scores are only comparable within one call: the scale (a logit, 0 to 10) is the scorer's own.
 * 3. The same question and passages give the same scores.
 * 4. A model that cannot be reached or loaded is a RagError coded PROVIDER_UNAVAILABLE.
 */
export interface RelevanceScorer {
  /** Identifies the scorer in logs and reports, e.g. "cross-encoder". */
  readonly name: string;
  score(query: string, passages: readonly string[]): Promise<readonly number[]>;
}

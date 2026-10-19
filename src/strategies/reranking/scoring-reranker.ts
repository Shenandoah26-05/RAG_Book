import type {
  Query,
  RelevanceScorer,
  RerankOptions,
  Reranker,
  RetrievedChunk,
} from "../../core/index.js";
import { RagError } from "../../shared/index.js";
import { assertRerankArguments } from "./noop-reranker.js";

export interface ScoringRerankerDeps {
  /** Rates each candidate's text against the question: a cross-encoder, or an LLM. */
  readonly scorer: RelevanceScorer;
}

/**
 * Reorders candidates by a `RelevanceScorer`: score every candidate's text against the question,
 * sort best first, keep `k`.
 *
 * - The scorer sees `chunk.text`, the passage as the reader and the LLM will see it.
 * - Equal scores keep the order the retriever gave, so the result is the same on every run.
 * - Each result keeps the chunk and its `retriever`; `score` and `rank` are the reranker's own.
 *   The retriever's score and rank are replaced, since they live on another scale.
 */
export class ScoringReranker implements Reranker {
  readonly name: string;
  readonly #scorer: RelevanceScorer;

  constructor(deps: ScoringRerankerDeps) {
    this.#scorer = deps.scorer;
    this.name = deps.scorer.name;
  }

  async rerank(
    query: Query,
    candidates: readonly RetrievedChunk[],
    options: RerankOptions,
  ): Promise<readonly RetrievedChunk[]> {
    assertRerankArguments(query, options);
    if (candidates.length === 0) return [];

    const scores = await this.#scorer.score(
      query.text,
      candidates.map((candidate) => candidate.chunk.text),
    );
    if (scores.length !== candidates.length || !scores.every(Number.isFinite)) {
      throw new RagError(
        "INTERNAL",
        `The ${this.#scorer.name} scorer returned ${scores.length.toString()} scores for ` +
          `${candidates.length.toString()} candidates, or a score that is not a finite number`,
      );
    }

    return candidates
      .map((candidate, index) => ({ candidate, index, score: scores[index] ?? 0 }))
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .slice(0, options.k)
      .map(({ candidate, score }, i) => ({
        chunk: candidate.chunk,
        score,
        rank: i + 1,
        retriever: candidate.retriever,
      }));
  }
}

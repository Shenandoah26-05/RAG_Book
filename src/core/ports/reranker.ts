import type { Query } from "../types/chat.js";
import type { RetrievedChunk } from "../types/retrieval.js";

export interface RerankOptions {
  /** How many chunks to return at most. A whole number of 1 or more. */
  readonly k: number;
}

/**
 * Reorders the candidates a retriever found, using a slower and more careful judgement of how
 * well each one answers the question (an LLM, a cross-encoder). It receives more candidates than
 * are finally needed and returns the best `k`.
 *
 * "Reranking off" is just another reranker (`NoopReranker`), so no code outside the composition
 * root ever checks whether reranking is switched on.
 *
 * Rules every reranker must follow. The shared contract test checks them:
 * 1. `rerank` returns at most `k` chunks, best first. Ranks are 1, 2, 3, ... with no gaps, scores
 *    never increase down the list, and a chunk appears once.
 * 2. It returns only chunks that were among the candidates. It never invents or adds chunks, and it
 *    keeps each chunk's `retriever` (where it was found).
 * 3. It does not change the `candidates` array or the objects in it.
 * 4. `k` that is not a whole number of 1 or more, or a question that is blank, is a RagError coded
 *    INVALID_ARGUMENT. No candidates gives an empty list.
 * 5. The same candidates and question give the same result.
 */
export interface Reranker {
  /** Identifies the reranker in logs and experiment reports, e.g. "noop". */
  readonly name: string;
  rerank(
    query: Query,
    candidates: readonly RetrievedChunk[],
    options: RerankOptions,
  ): Promise<readonly RetrievedChunk[]>;
}

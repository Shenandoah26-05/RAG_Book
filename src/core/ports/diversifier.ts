import type { RetrievedChunk } from "../types/retrieval.js";

/**
 * Picks the chunks to keep from a list of candidates so that they do not repeat each other: a book
 * says the same thing in the introduction, the chapter and the summary, and five near-copies would
 * fill the context for nothing. It runs after retrieval (and reranking), on any retriever's output.
 * The first implementation is MMR (RAG-053).
 *
 * Rules every diversifier must follow:
 * 1. `diversify` returns at most `k` of the candidates, each once, and never a chunk that was not
 *    in `candidates`. Fewer candidates than `k` gives all of them, in the new order.
 * 2. Each returned chunk keeps its `chunk`, `score` and `retriever` as they came in. Only `rank`
 *    changes: it is 1, 2, 3, ... down the new order. Scores therefore need not be in descending
 *    order any more; the order is the diversifier's decision.
 * 3. The same candidates give the same result.
 * 4. `k` that is not a whole number of 1 or more, or a chunk that appears twice among the
 *    candidates, is a RagError coded INVALID_ARGUMENT. No candidates gives an empty list.
 */
export interface Diversifier {
  /** Identifies the strategy in reports, e.g. "mmr". */
  readonly name: string;
  /** `candidates` are in the order the retriever ranked them, best first. */
  diversify(candidates: readonly RetrievedChunk[], k: number): Promise<readonly RetrievedChunk[]>;
}

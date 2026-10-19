import type { ScoredId } from "../types/retrieval.js";

/** The hits one retriever found for a question, best first. */
export interface RankedList {
  /** The retriever's `name`. Unique among the lists given to one `fuse` call. */
  readonly retriever: string;
  /** Best first. A chunk id appears at most once. */
  readonly hits: readonly ScoredId[];
}

/**
 * Combines the rankings of several retrievers into one. The scores of different retrievers cannot
 * simply be added: a cosine similarity lies between -1 and 1, a BM25 score has no upper limit, so
 * the bigger scale would decide everything. A fusion strategy is the rule for combining them
 * anyway: Reciprocal Rank Fusion uses only the ranks, a weighted sum rescales each list first.
 *
 * It works on ids and scores, never on text, so it is a pure function.
 *
 * Rules every strategy must follow. The shared tests check them:
 * 1. The result holds every id that appears in any list, once, best first. Equal scores are ordered
 *    by id, ascending, so the same lists always give the same result.
 * 2. No list is changed.
 * 3. No lists, or lists with no hits, give an empty result.
 * 4. Two lists with the same `retriever`, or a chunk id twice in one list, are INVALID_ARGUMENT.
 *
 * The returned score is the fused score. It means something only within one result and is not
 * comparable with the scores of the retrievers it was made from.
 */
export interface FusionStrategy {
  /** The name used in config and reports, e.g. "rrf". */
  readonly name: string;
  fuse(lists: readonly RankedList[]): readonly ScoredId[];
}

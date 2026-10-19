import type { ChunkId, FusionStrategy, RankedList, ScoredId } from "../../core/index.js";
import { RagError } from "../../shared/index.js";
import { assertValidLists, rankScores } from "./fusion-input.js";

/** The constant from the paper that introduced RRF (Cormack et al., 2009). */
export const DEFAULT_RRF_K = 60;

/**
 * Reciprocal Rank Fusion. Each list gives a chunk `1 / (k + rank)`, where rank is its place in that
 * list (1 for the best), and the chunk's fused score is the sum over the lists it appears in.
 *
 * Only the ranks are used, never the scores, so it does not matter that cosine and BM25 scores live
 * on different scales, and no list needs rescaling. A chunk near the top of two lists beats one at
 * the very top of just one. `k` softens the top: with k = 60, rank 1 is worth 1/61 and rank 2 1/62,
 * so the first place is not worth much more than the second.
 */
export class RrfFusion implements FusionStrategy {
  readonly name = "rrf";
  readonly #k: number;

  /** @throws RagError INVALID_ARGUMENT if `k` is not a whole number of 1 or more */
  constructor(k: number = DEFAULT_RRF_K) {
    if (!Number.isInteger(k) || k < 1) {
      throw new RagError(
        "INVALID_ARGUMENT",
        `RRF k must be a whole number of 1 or more, got ${String(k)}`,
      );
    }
    this.#k = k;
  }

  fuse(lists: readonly RankedList[]): readonly ScoredId[] {
    assertValidLists(lists);
    const scores = new Map<ChunkId, number>();
    for (const list of lists) {
      list.hits.forEach((hit, index) => {
        scores.set(hit.id, (scores.get(hit.id) ?? 0) + 1 / (this.#k + index + 1));
      });
    }
    return rankScores(scores);
  }
}

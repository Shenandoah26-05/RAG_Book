import type { ChunkId, FusionStrategy, RankedList, ScoredId } from "../../core/index.js";
import { RagError } from "../../shared/index.js";
import { assertValidLists, rankScores } from "./fusion-input.js";

/**
 * A weighted sum of min-max normalised scores. Each list is first rescaled so its best hit scores 1
 * and its worst scores 0 (`(score - min) / (max - min)`), which puts cosine and BM25 on the same
 * 0 to 1 scale; then a chunk's fused score is the sum over the lists of `weight * normalised score`.
 * A chunk missing from a list gets 0 from it.
 *
 * Weights are given by retriever name, for example `{ dense: 0.7, bm25: 0.3 }`. They are divided by
 * their sum (over the lists present in a call), so only their proportions matter and a fused score
 * is always between 0 and 1.
 *
 * Two things to know about min-max. The worst hit of every list scores 0 and so adds nothing from
 * that list, because the list is only the top results, not the whole index. And a list whose scores
 * are all equal (or that has one hit) has no spread to rescale, so its hits all count as 1.
 */
export class WeightedFusion implements FusionStrategy {
  readonly name = "weighted";
  readonly #weights: ReadonlyMap<string, number>;

  /** @throws RagError INVALID_ARGUMENT for a weight that is negative or not finite */
  constructor(weights: Readonly<Record<string, number>>) {
    const entries = Object.entries(weights);
    for (const [retriever, weight] of entries) {
      if (!Number.isFinite(weight) || weight < 0) {
        throw new RagError(
          "INVALID_ARGUMENT",
          `Weight of "${retriever}" must be a number of 0 or more, got ${String(weight)}`,
        );
      }
    }
    this.#weights = new Map(entries);
  }

  fuse(lists: readonly RankedList[]): readonly ScoredId[] {
    assertValidLists(lists);
    const weighted = lists.map((list) => {
      const weight = this.#weights.get(list.retriever);
      if (weight === undefined) {
        throw new RagError(
          "INVALID_ARGUMENT",
          `No weight for the retriever "${list.retriever}". Weights are given for: ${[...this.#weights.keys()].join(", ")}`,
        );
      }
      return { list, weight };
    });
    const total = weighted.reduce((sum, { weight }) => sum + weight, 0);
    if (weighted.length > 0 && total <= 0) {
      throw new RagError("INVALID_ARGUMENT", "At least one weight must be greater than 0");
    }

    const scores = new Map<ChunkId, number>();
    for (const { list, weight } of weighted) {
      const values = list.hits.map((hit) => hit.score);
      const min = Math.min(...values);
      const spread = Math.max(...values) - min;
      for (const hit of list.hits) {
        const normalised = spread === 0 ? 1 : (hit.score - min) / spread;
        scores.set(hit.id, (scores.get(hit.id) ?? 0) + (weight / total) * normalised);
      }
    }
    return rankScores(scores);
  }
}

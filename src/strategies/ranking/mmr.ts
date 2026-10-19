import { RagError } from "../../shared/index.js";

/**
 * Scales scores to the range 0 to 1: the lowest becomes 0, the highest 1, the rest in proportion.
 * Scores from different retrievers (cosine, BM25, fused ranks) live on different scales, so MMR
 * puts relevance on one scale before weighing it against similarity. If all scores are equal there
 * is nothing to tell them apart, and every one becomes 1.
 */
export function minMaxScale(scores: readonly number[]): number[] {
  if (scores.length === 0) return [];
  const low = Math.min(...scores);
  const high = Math.max(...scores);
  return high === low ? scores.map(() => 1) : scores.map((s) => (s - low) / (high - low));
}

/**
 * Maximal Marginal Relevance: chooses `k` items one at a time, each time taking the one with the
 * best balance of being relevant and being different from what is already chosen:
 *
 *   pick = argmax over the rest of   lambda * relevance(i)  -  (1 - lambda) * max similarity(i, chosen)
 *
 * With nothing chosen yet the second term is 0, so the first pick is the most relevant item.
 * `lambda = 1` ignores similarity and gives the items in order of relevance; `lambda = 0` ignores
 * relevance and keeps adding whatever is least like what is chosen.
 *
 * @param relevance one number per item, on a scale where it can be compared with `similarity`
 *   (0 to 1 is the intended range, see `minMaxScale`)
 * @param similarity how alike items `i` and `j` are, 0 (unrelated) to 1 (the same). Called at most
 *   once per pair.
 * @returns the indices of the chosen items in the order they were chosen. Equal values are decided
 *   by the lower index, so give the items best-first and ties favour the better-ranked one.
 * @throws RagError INVALID_ARGUMENT if `lambda` is not from 0 to 1 or `k` is not a whole number of 1+
 */
export function mmrOrder(
  relevance: readonly number[],
  similarity: (i: number, j: number) => number,
  k: number,
  lambda: number,
): number[] {
  if (!Number.isFinite(lambda) || lambda < 0 || lambda > 1) {
    throw new RagError(
      "INVALID_ARGUMENT",
      `lambda must be a number from 0 to 1, got ${String(lambda)}`,
    );
  }
  if (!Number.isInteger(k) || k < 1) {
    throw new RagError(
      "INVALID_ARGUMENT",
      `k must be a whole number of 1 or more, got ${String(k)}`,
    );
  }

  const chosen: number[] = [];
  const remaining = new Set(relevance.keys());
  // for each item: its highest similarity to anything chosen so far (0 while nothing is)
  const closest = relevance.map(() => 0);

  while (chosen.length < k && remaining.size > 0) {
    let best = -1;
    let bestValue = Number.NEGATIVE_INFINITY;
    for (const i of remaining) {
      const value = lambda * (relevance[i] ?? 0) - (1 - lambda) * (closest[i] ?? 0);
      // strictly greater: the lower index wins a tie, because the set is walked in index order
      if (value > bestValue) {
        best = i;
        bestValue = value;
      }
    }
    chosen.push(best);
    remaining.delete(best);
    for (const i of remaining) {
      closest[i] = Math.max(closest[i] ?? 0, similarity(i, best));
    }
  }
  return chosen;
}

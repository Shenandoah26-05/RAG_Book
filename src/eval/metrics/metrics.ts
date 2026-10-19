import type { RetrievedChunk } from "../../core/index.js";
import { RagError } from "../../shared/index.js";
import { judgeRetrieval } from "./judge.js";
import type { GoldPassage, RetrievalJudgement } from "./judge.js";

// The five retrieval metrics, written by hand. Each reads a `RetrievalJudgement` and a cutoff `k`
// (only the first `k` results count). All are numbers from 0 to 1, higher is better.
//
//   metric        asks                                              rewards
//   hit@k         is anything relevant in the top k?                finding at least one passage
//   precision@k   how much of the top k is relevant?                a clean top k, no filler
//   recall@k      how many of the gold passages did the top k find? finding all of a multi-part answer
//   MRR           how early is the first relevant result?           putting the answer first
//   nDCG@k        are the gold passages found, and found high up?   the whole ordering

function assertCutoff(k: number): void {
  if (!Number.isInteger(k) || k < 1) {
    throw new RagError(
      "INVALID_ARGUMENT",
      `k must be a whole number of 1 or more, got ${String(k)}`,
    );
  }
}

const top = <T>(items: readonly T[], k: number): readonly T[] => items.slice(0, k);

/** 1 if any of the first `k` results is relevant, else 0. */
export function hitAtK(judgement: RetrievalJudgement, k: number): number {
  assertCutoff(k);
  return top(judgement.relevant, k).some(Boolean) ? 1 : 0;
}

/**
 * The share of the top `k` that is relevant. It divides by `k` even when fewer results came back,
 * so returning less is not rewarded.
 */
export function precisionAtK(judgement: RetrievalJudgement, k: number): number {
  assertCutoff(k);
  return top(judgement.relevant, k).filter(Boolean).length / k;
}

/**
 * The share of the gold passages that the top `k` found (a passage is found when some result
 * overlaps it). Gold passages are counted, not relevant chunks: how many chunks could be relevant
 * depends on the chunker, while the passages are fixed by the dataset.
 */
export function recallAtK(judgement: RetrievalJudgement, k: number): number {
  assertCutoff(k);
  return top(judgement.newlyCovered, k).filter(Boolean).length / judgement.goldCount;
}

/**
 * The reciprocal rank: 1 divided by the rank of the first relevant result, 0 if there is none in
 * the first `k` (default: all results). The mean over questions is the MRR.
 */
export function reciprocalRank(
  judgement: RetrievalJudgement,
  k: number = judgement.relevant.length,
): number {
  if (k === 0 && judgement.relevant.length === 0) return 0;
  assertCutoff(k);
  const index = top(judgement.relevant, k).indexOf(true);
  return index < 0 ? 0 : 1 / (index + 1);
}

/**
 * Normalised discounted cumulative gain. A result earns 1 for finding a gold passage that nothing
 * ranked above it found, discounted by `1 / log2(rank + 1)`: finding it first is worth 1, second
 * 0.63, third 0.5. The sum is divided by the best possible sum, where the passages (at most `k` of
 * them) are found at ranks 1, 2, 3, ... so 1 is a perfect ranking and the value cannot exceed 1.
 */
export function ndcgAtK(judgement: RetrievalJudgement, k: number): number {
  assertCutoff(k);
  const discount = (rank: number): number => 1 / Math.log2(rank + 1);
  let dcg = 0;
  top(judgement.newlyCovered, k).forEach((found, index) => {
    if (found) dcg += discount(index + 1);
  });
  let ideal = 0;
  for (let rank = 1; rank <= Math.min(k, judgement.goldCount); rank += 1) ideal += discount(rank);
  return dcg / ideal;
}

/** All five metrics for one question at one cutoff. */
export interface RetrievalMetrics {
  readonly k: number;
  readonly hit: number;
  readonly precision: number;
  readonly recall: number;
  /** Reciprocal rank within the first `k` results. */
  readonly mrr: number;
  readonly ndcg: number;
}

export function retrievalMetrics(judgement: RetrievalJudgement, k: number): RetrievalMetrics {
  assertCutoff(k);
  return {
    k,
    hit: hitAtK(judgement, k),
    precision: precisionAtK(judgement, k),
    recall: recallAtK(judgement, k),
    mrr: reciprocalRank(judgement, k),
    ndcg: ndcgAtK(judgement, k),
  };
}

/**
 * Scores one question's results at each cutoff in `ks`.
 * @throws RagError INVALID_ARGUMENT for no gold passages or a bad cutoff
 */
export function scoreRetrieval(
  retrieved: readonly Pick<RetrievedChunk, "chunk">[],
  gold: readonly GoldPassage[],
  ks: readonly number[],
): readonly RetrievalMetrics[] {
  const judgement = judgeRetrieval(retrieved, gold);
  return ks.map((k) => retrievalMetrics(judgement, k));
}

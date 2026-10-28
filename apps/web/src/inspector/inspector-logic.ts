import type { WireCandidate, WireInspection, WireStage, WireTrace } from "@rag-book/api-contract";

// What the inspector says about an answer, as plain functions of the data the API sent. No React
// here, so every wording and every edge (a chunk cut by the reranker, a prompt over its budget) is
// a test with a value in and a value out.

/** What the reranker did to one chunk. */
export type RerankMove =
  | { readonly kind: "cut" }
  | { readonly kind: "same"; readonly rank: number }
  | { readonly kind: "up" | "down"; readonly from: number; readonly to: number };

export function rerankMove(candidate: WireCandidate): RerankMove {
  if (candidate.finalRank === null) return { kind: "cut" };
  if (candidate.finalRank === candidate.rank) return { kind: "same", rank: candidate.rank };
  return {
    kind: candidate.finalRank < candidate.rank ? "up" : "down",
    from: candidate.rank,
    to: candidate.finalRank,
  };
}

/** The move in words, for a screen reader and for the tooltip. */
export function describeMove(move: RerankMove): string {
  switch (move.kind) {
    case "cut":
      return "Dropped by the reranker";
    case "same":
      return `Kept at place ${move.rank.toString()}`;
    case "up":
      return `Moved up from place ${move.from.toString()} to ${move.to.toString()}`;
    case "down":
      return `Moved down from place ${move.from.toString()} to ${move.to.toString()}`;
  }
}

/** Whether the reranker changed the order or the set: the same as asking if any chunk moved. */
export function rerankChangedAnything(candidates: readonly WireCandidate[]): boolean {
  return candidates.some((c) => rerankMove(c).kind !== "same");
}

/** What became of a chunk, in words. */
export function describeFate(candidate: WireCandidate): string {
  switch (candidate.fate) {
    case "used":
      return candidate.source === undefined
        ? "In the prompt"
        : `In the prompt as [${candidate.source.toString()}]`;
    case "duplicate":
      return "Left out: a duplicate";
    case "over-budget":
      return "Left out: over the token budget";
    case "cut":
      return "Not used: cut by the reranker";
  }
}

/** A score for display. Scores of different retrievers are on different scales, so no rounding to 2. */
export function formatScore(score: number): string {
  if (score === 0) return "0";
  const magnitude = Math.abs(score);
  if (magnitude >= 100) return score.toFixed(1);
  if (magnitude >= 1) return score.toFixed(2);
  return score.toPrecision(2);
}

export function pagesLabel(candidate: Pick<WireCandidate, "pageStart" | "pageEnd">): string {
  return candidate.pageStart === candidate.pageEnd
    ? `p. ${candidate.pageStart.toString()}`
    : `pp. ${candidate.pageStart.toString()}–${candidate.pageEnd.toString()}`;
}

/** How much of the token budget the sources took, from 0 to 1. A budget of 0 is full. */
export function budgetShare(prompt: WireInspection["prompt"]): number {
  if (prompt.budget <= 0) return 1;
  return Math.min(1, Math.max(0, prompt.sourceTokens / prompt.budget));
}

/** One stage's summary as `key value` pairs in the order the pipeline wrote them. */
export function summaryPairs(stage: WireStage): readonly (readonly [string, string])[] {
  return Object.entries(stage.summary).map(([key, value]) => [
    key,
    value === null ? "–" : String(value),
  ]);
}

export function formatMs(ms: number): string {
  return ms < 10
    ? `${ms.toFixed(1)} ms`
    : ms < 1000
      ? `${Math.round(ms).toString()} ms`
      : `${(ms / 1000).toFixed(1)} s`;
}

/** What the calls behind the answer came to, as one line; empty when nothing was called. */
export function describeUsage(usage: WireTrace["usage"]): string {
  if (usage === undefined) return "";
  const parts = [
    `${usage.calls.toString()} ${usage.calls === 1 ? "call" : "calls"}`,
    `${usage.promptTokens.toString()} prompt tokens`,
    `${usage.outputTokens.toString()} answer tokens`,
  ];
  if (usage.cost !== undefined) {
    parts.push(`${usage.cost.amount.toFixed(4)} ${usage.cost.currency}`);
  }
  return parts.join(" · ");
}

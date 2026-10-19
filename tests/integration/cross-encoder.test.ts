import { describe, expect, it } from "vitest";
import { CrossEncoderScorer } from "../../src/adapters/rerankers/index.js";
import { ScoringReranker } from "../../src/strategies/reranking/index.js";
import {
  describeRerankerContract,
  makeCandidates,
} from "../../src/testing/reranker-contract.testing.js";

// Runs the real MS MARCO MiniLM cross-encoder (a 23 MB download the first time, then cached), so it
// is off unless asked for: `RAG_TEST_MODELS=1 pnpm test tests/integration/cross-encoder`.
const enabled = process.env.RAG_TEST_MODELS === "1";

const passages = [
  "Venus is often called Earth's twin because of its similar size.",
  "Quarterly tax returns are due in April.",
  "Mars, known for its reddish appearance, is often called the Red Planet.",
  "The mitochondria is the powerhouse of the cell.",
];
const query = { text: "Which planet is known as the Red Planet?" };

describe.skipIf(!enabled)("CrossEncoderScorer against the real model", () => {
  const scorer = new CrossEncoderScorer();
  const candidates = makeCandidates(passages);

  describeRerankerContract("ScoringReranker (real cross-encoder)", () =>
    Promise.resolve({ reranker: new ScoringReranker({ scorer }), query, candidates }),
  );

  it("puts the passage that answers the question first, and the same scores each time", async () => {
    const first = await scorer.score(query.text, passages);
    expect(first.indexOf(Math.max(...first))).toBe(2);
    expect(await scorer.score(query.text, passages)).toEqual(first);
  }, 120_000);

  // Padding a batch to its longest pair shifts the scores of this 8-bit model a little (about
  // 0.05 on a scale where relevant and irrelevant passages are 10 or more apart), so the batch
  // size is not a free choice, but it does not change the ranking of clearly different passages.
  it("ranks the same whatever the batch size, with scores that differ only slightly", async () => {
    const one = await new CrossEncoderScorer({ batchSize: 1 }).score(query.text, passages);
    const all = await scorer.score(query.text, passages);
    const order = (scores: readonly number[]): number[] =>
      scores.map((_, i) => i).sort((a, b) => (scores[b] ?? 0) - (scores[a] ?? 0));
    expect(order(one)).toEqual(order(all));
    one.forEach((score, i) => {
      expect(Math.abs(score - (all[i] ?? Number.NaN))).toBeLessThan(0.25);
    });
  }, 120_000);
});

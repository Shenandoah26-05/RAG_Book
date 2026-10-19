import { describe, expect, it } from "vitest";
import type { RelevanceScorer } from "../../core/index.js";
import {
  describeRerankerContract,
  makeCandidates,
} from "../../testing/reranker-contract.testing.js";
import { ScoringReranker } from "./scoring-reranker.js";

const query = { text: "which animal purrs" };
const candidates = makeCandidates(["dogs bark", "cats purr", "cars drive", "fish swim"]);

/** Scores by a table of text -> score; a text not in it scores 0. */
function tableScorer(table: Record<string, number>): RelevanceScorer & {
  calls: { query: string; passages: readonly string[] }[];
} {
  const calls: { query: string; passages: readonly string[] }[] = [];
  return {
    name: "table",
    calls,
    score: (q, passages) => {
      calls.push({ query: q, passages });
      return Promise.resolve(passages.map((p) => table[p] ?? 0));
    },
  };
}

const CATS_FIRST = { "cats purr": 9, "dogs bark": 4, "fish swim": 1, "cars drive": -3 };

describeRerankerContract("ScoringReranker", () =>
  Promise.resolve({
    reranker: new ScoringReranker({ scorer: tableScorer(CATS_FIRST) }),
    query,
    candidates,
  }),
);

describe("ScoringReranker", () => {
  it("orders the candidates by the scorer's scores, with the scorer's scores and new ranks", async () => {
    const reranker = new ScoringReranker({ scorer: tableScorer(CATS_FIRST) });
    const results = await reranker.rerank(query, candidates, { k: 10 });
    expect(results.map((r) => r.chunk.text)).toEqual([
      "cats purr",
      "dogs bark",
      "fish swim",
      "cars drive",
    ]);
    expect(results.map((r) => r.score)).toEqual([9, 4, 1, -3]);
    expect(results.map((r) => r.rank)).toEqual([1, 2, 3, 4]);
  });

  it("keeps the best k, and the retriever that found each chunk", async () => {
    const reranker = new ScoringReranker({ scorer: tableScorer(CATS_FIRST) });
    const results = await reranker.rerank(query, candidates, { k: 2 });
    expect(results.map((r) => r.chunk.text)).toEqual(["cats purr", "dogs bark"]);
    expect(results.every((r) => r.retriever === "dense")).toBe(true);
  });

  it("keeps the retriever's order between equal scores", async () => {
    const reranker = new ScoringReranker({ scorer: tableScorer({}) });
    const results = await reranker.rerank(query, candidates, { k: 4 });
    expect(results.map((r) => r.chunk.text)).toEqual(candidates.map((c) => c.chunk.text));
  });

  it("gives the scorer the question and the passage texts, once, in the candidates' order", async () => {
    const scorer = tableScorer(CATS_FIRST);
    await new ScoringReranker({ scorer }).rerank(query, candidates, { k: 2 });
    expect(scorer.calls).toEqual([
      {
        query: "which animal purrs",
        passages: ["dogs bark", "cats purr", "cars drive", "fish swim"],
      },
    ]);
  });

  it("is named after its scorer", () => {
    expect(new ScoringReranker({ scorer: tableScorer({}) }).name).toBe("table");
  });

  it("does not call the scorer for no candidates or for bad arguments", async () => {
    const scorer = tableScorer(CATS_FIRST);
    const reranker = new ScoringReranker({ scorer });
    expect(await reranker.rerank(query, [], { k: 3 })).toEqual([]);
    await expect(reranker.rerank(query, candidates, { k: 0 })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    await expect(reranker.rerank({ text: "  " }, candidates, { k: 3 })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    expect(scorer.calls).toEqual([]);
  });

  it.each([
    ["too few scores", [1, 2]],
    ["too many scores", [1, 2, 3, 4, 5]],
    ["a NaN score", [1, Number.NaN, 3, 4]],
    ["an infinite score", [1, 2, Number.POSITIVE_INFINITY, 4]],
  ])("fails with INTERNAL when the scorer returns %s", async (_name, scores) => {
    const scorer: RelevanceScorer = { name: "broken", score: () => Promise.resolve(scores) };
    await expect(
      new ScoringReranker({ scorer }).rerank(query, candidates, { k: 3 }),
    ).rejects.toMatchObject({ code: "INTERNAL" });
  });

  it("passes the scorer's own errors through", async () => {
    const scorer: RelevanceScorer = {
      name: "down",
      score: () => Promise.reject(new Error("model unreachable")),
    };
    await expect(
      new ScoringReranker({ scorer }).rerank(query, candidates, { k: 3 }),
    ).rejects.toThrow("model unreachable");
  });
});

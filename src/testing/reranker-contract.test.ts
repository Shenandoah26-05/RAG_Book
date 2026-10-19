import { describe, expect, it } from "vitest";
import type { RetrievedChunk } from "../core/index.js";
import { checkReranked, makeCandidates } from "./reranker-contract.testing.js";

const candidates = makeCandidates(["a", "b", "c"]);
const at = (i: number): RetrievedChunk => {
  const candidate = candidates[i];
  if (candidate === undefined) throw new Error("fixture missing");
  return candidate;
};
const codes = (results: readonly RetrievedChunk[], k = 5) =>
  checkReranked(results, candidates, k).map((v) => v.code);

describe("checkReranked", () => {
  it("accepts the candidates in the same order, a reordering, a subset, and nothing", () => {
    expect(codes(candidates)).toEqual([]);
    expect(
      codes([
        { ...at(2), rank: 1, score: 0.8 },
        { ...at(0), rank: 2, score: 0.5 },
      ]),
    ).toEqual([]);
    expect(codes([at(0)])).toEqual([]);
    expect(codes([])).toEqual([]);
  });

  it("catches more results than k", () => {
    expect(codes(candidates, 2)).toEqual(["too-many"]);
  });

  it("catches ranks that do not run 1, 2, 3", () => {
    expect(
      codes([
        { ...at(0), rank: 2 },
        { ...at(1), rank: 3 },
      ]),
    ).toEqual(["bad-rank", "bad-rank"]);
  });

  it("catches a score that goes up", () => {
    expect(
      codes([
        { ...at(0), score: 0.1 },
        { ...at(1), score: 0.9, rank: 2 },
      ]),
    ).toEqual(["score-increases"]);
  });

  it("catches the same chunk twice", () => {
    expect(codes([at(0), { ...at(0), rank: 2, score: 0.1 }])).toEqual(["duplicate"]);
  });

  it("catches a chunk that was not a candidate", () => {
    const stranger = makeCandidates(["zzz"])[0];
    if (stranger === undefined) throw new Error("fixture missing");
    expect(codes([stranger])).toEqual(["unknown-chunk"]);
  });

  it("catches a chunk whose text was changed", () => {
    expect(codes([{ ...at(0), chunk: { ...at(0).chunk, text: "changed" } }])).toEqual([
      "changed-chunk",
    ]);
  });

  it("catches a changed retriever name", () => {
    expect(codes([{ ...at(0), retriever: "reranker" }])).toEqual(["changed-retriever"]);
  });
});

describe("makeCandidates", () => {
  it("builds ranked, falling-score results with distinct ids", () => {
    expect(candidates.map((c) => c.rank)).toEqual([1, 2, 3]);
    expect(new Set(candidates.map((c) => c.chunk.id)).size).toBe(3);
    expect(candidates[0]?.score).toBeGreaterThan(candidates[1]?.score ?? 1);
    expect(checkReranked(candidates, candidates, 3)).toEqual([]);
  });
});

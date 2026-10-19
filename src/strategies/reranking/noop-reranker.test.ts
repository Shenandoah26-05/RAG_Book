import { describe, expect, it } from "vitest";
import {
  describeRerankerContract,
  makeCandidates,
} from "../../testing/reranker-contract.testing.js";
import { NoopReranker } from "./noop-reranker.js";

const candidates = makeCandidates(["a", "b", "c", "d"]);
const query = { text: "anything" };

describeRerankerContract("NoopReranker", () =>
  Promise.resolve({ reranker: new NoopReranker(), query, candidates }),
);

describe("NoopReranker", () => {
  it("returns the candidates unchanged: same order, scores, ranks and objects", async () => {
    const results = await new NoopReranker().rerank(query, candidates, { k: 10 });
    expect(results).toEqual(candidates);
    results.forEach((r, i) => {
      expect(r).toBe(candidates[i]);
    });
  });

  it("only cuts the list to k", async () => {
    expect(await new NoopReranker().rerank(query, candidates, { k: 2 })).toEqual(
      candidates.slice(0, 2),
    );
  });

  it("is called noop", () => {
    expect(new NoopReranker().name).toBe("noop");
  });
});

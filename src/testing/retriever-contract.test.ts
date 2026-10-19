import { describe, expect, it } from "vitest";
import { makeChunkId } from "../core/index.js";
import type { Chunk, RetrievedChunk } from "../core/index.js";
import { makeDocId } from "../shared/index.js";
import { checkRetrieved } from "./retriever-contract.testing.js";

const DOC = makeDocId("a".repeat(64));

function result(text: string, rank: number, score: number, retriever = "dense"): RetrievedChunk {
  const chunk: Chunk = {
    id: makeChunkId({ docId: DOC, strategy: "s", charStart: 0, charEnd: text.length, text }),
    text,
    metadata: {
      docId: DOC,
      pageStart: 1,
      pageEnd: 1,
      sectionPath: [],
      charStart: 0,
      charEnd: text.length,
      strategy: "s",
    },
  };
  return { chunk, rank, score, retriever };
}

const codes = (results: readonly RetrievedChunk[], k = 5, allowed?: (c: Chunk) => boolean) =>
  checkRetrieved(results, { name: "dense", k, ...(allowed === undefined ? {} : { allowed }) }).map(
    (v) => v.code,
  );

describe("checkRetrieved", () => {
  it("accepts a correct result, and an empty one", () => {
    expect(codes([result("a", 1, 0.9), result("b", 2, 0.5), result("c", 3, 0.5)])).toEqual([]);
    expect(codes([])).toEqual([]);
  });

  it("catches more results than k", () => {
    expect(codes([result("a", 1, 0.9), result("b", 2, 0.5)], 1)).toEqual(["too-many"]);
  });

  it("catches ranks that do not run 1, 2, 3", () => {
    expect(codes([result("a", 0, 0.9), result("b", 1, 0.5)])).toEqual(["bad-rank", "bad-rank"]);
    expect(codes([result("a", 1, 0.9), result("b", 3, 0.5)])).toEqual(["bad-rank"]);
  });

  it("catches a score that goes up", () => {
    expect(codes([result("a", 1, 0.5), result("b", 2, 0.9)])).toEqual(["score-increases"]);
  });

  it("catches another retriever's name", () => {
    expect(codes([result("a", 1, 0.9, "bm25")])).toEqual(["wrong-retriever"]);
  });

  it("catches the same chunk twice", () => {
    expect(codes([result("a", 1, 0.9), result("a", 2, 0.5)])).toEqual(["duplicate"]);
  });

  it("catches a chunk the filter does not allow", () => {
    expect(codes([result("a", 1, 0.9), result("b", 2, 0.5)], 5, (c) => c.text === "a")).toEqual([
      "filter-violated",
    ]);
  });

  describe("reports every problem, not just the first", () => {
    it("lists several codes for one bad result", () => {
      const found = new Set(codes([result("a", 2, 0.1, "x"), result("b", 2, 0.9, "x")], 1));
      expect(found).toEqual(
        new Set(["too-many", "bad-rank", "wrong-retriever", "score-increases"]),
      );
    });
  });
});

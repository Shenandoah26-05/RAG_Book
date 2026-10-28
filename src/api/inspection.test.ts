import { wireInspectionSchema } from "@rag-book/api-contract";
import { describe, expect, it } from "vitest";
import type { AssembledPrompt, RetrievedChunk } from "../core/index.js";
import type { RetrievalReport } from "../pipeline/index.js";
import { chunkOf } from "./api.testing.js";
import { snippetOf, SNIPPET_CHARS, toWireInspection } from "./inspection.js";

const A = chunkOf("Embeddings map text to vectors.");
const B = chunkOf("Cosine similarity compares the direction of two vectors.");
const C = chunkOf("A vector store keeps vectors and finds the nearest ones.");
const D = chunkOf("Similar meanings sit close together.");

const hit = (chunk: typeof A, rank: number, score: number, retriever: string): RetrievedChunk => ({
  chunk,
  rank,
  score,
  retriever,
});

/**
 * Four candidates from a hybrid. The reranker puts B first, A second, C third and drops D. The
 * prompt has room for two: B and A are used, C is over budget.
 */
function scenario(): { retrieval: RetrievalReport; prompt: AssembledPrompt } {
  const retrieval: RetrievalReport = {
    candidates: [
      hit(A, 1, 0.03, "hybrid"),
      hit(B, 2, 0.02, "hybrid"),
      hit(C, 3, 0.01, "hybrid"),
      hit(D, 4, 0.005, "hybrid"),
    ],
    ranked: [hit(B, 1, 7, "hybrid"), hit(A, 2, 5, "hybrid"), hit(C, 3, 3, "hybrid")],
    retrievers: [
      { name: "dense", results: [hit(B, 1, 0.9, "dense"), hit(A, 2, 0.8, "dense")] },
      { name: "bm25", results: [hit(A, 1, 3.2, "bm25"), hit(C, 2, 2.1, "bm25")] },
    ],
  };
  const prompt: AssembledPrompt = {
    system: "SYSTEM",
    user: "What is an embedding?",
    promptVersion: "rag-system@v2",
    included: retrieval.ranked.slice(0, 2),
    citations: [],
    dropped: [{ chunk: hit(C, 3, 3, "hybrid"), reason: "over-budget" }],
    sourceTokens: 80,
    budget: 100,
  };
  return { retrieval, prompt };
}

const byText = (inspection: ReturnType<typeof toWireInspection>, text: string) => {
  const found = inspection.candidates.find((c) => c.snippet === text);
  if (found === undefined) throw new Error(`no candidate "${text}"`);
  return found;
};

describe("toWireInspection: the chunks", () => {
  const { retrieval, prompt } = scenario();
  const inspection = toWireInspection(retrieval, prompt, true);

  it("lists the candidates in the order retrieval ranked them", () => {
    expect(inspection.candidates.map((c) => c.rank)).toEqual([1, 2, 3, 4]);
    expect(inspection.candidates.map((c) => c.snippet)).toEqual([A.text, B.text, C.text, D.text]);
  });

  it("gives each candidate its retrieval score and the retriever that handed it on", () => {
    expect(byText(inspection, A.text)).toMatchObject({ score: 0.03, retriever: "hybrid" });
  });

  it("shows where the reranker moved a chunk, and its score", () => {
    expect(byText(inspection, A.text)).toMatchObject({ rank: 1, finalRank: 2, finalScore: 5 });
    expect(byText(inspection, B.text)).toMatchObject({ rank: 2, finalRank: 1, finalScore: 7 });
  });

  it("says a chunk the reranker dropped is cut, with no final place", () => {
    expect(byText(inspection, D.text)).toMatchObject({
      fate: "cut",
      finalRank: null,
      finalScore: null,
    });
  });

  it("numbers the chunks used the way the prompt does", () => {
    expect(byText(inspection, B.text)).toMatchObject({ fate: "used", source: 1 });
    expect(byText(inspection, A.text)).toMatchObject({ fate: "used", source: 2 });
  });

  it("says why a chunk that reached the assembler was left out", () => {
    const c = byText(inspection, C.text);
    expect(c.fate).toBe("over-budget");
    expect(c.source).toBeUndefined();
    expect(c.finalRank).toBe(3);
  });

  it("says duplicate for a duplicate", () => {
    const { retrieval: r, prompt: p } = scenario();
    const dup = toWireInspection(
      r,
      { ...p, dropped: [{ chunk: hit(C, 3, 3, "hybrid"), reason: "duplicate" }] },
      true,
    );
    expect(byText(dup, C.text).fate).toBe("duplicate");
  });

  it("carries the page and the section path", () => {
    expect(byText(inspection, A.text)).toMatchObject({
      pageStart: 1,
      pageEnd: 2,
      sectionPath: ["Chapter 1", "1.1 Vectors"],
      chunkId: A.id,
    });
  });
});

describe("toWireInspection: who found a chunk", () => {
  const { retrieval, prompt } = scenario();
  const inspection = toWireInspection(retrieval, prompt, true);

  it("lists each base retriever that found it with its own rank and score, best rank first", () => {
    expect(byText(inspection, A.text).foundBy).toEqual([
      { retriever: "bm25", rank: 1, score: 3.2 },
      { retriever: "dense", rank: 2, score: 0.8 },
    ]);
  });

  it("lists one retriever when only that one found it", () => {
    expect(byText(inspection, B.text).foundBy).toEqual([
      { retriever: "dense", rank: 1, score: 0.9 },
    ]);
    expect(byText(inspection, C.text).foundBy).toEqual([
      { retriever: "bm25", rank: 2, score: 2.1 },
    ]);
  });

  it("lists none for a chunk no retriever reported", () => {
    expect(byText(inspection, D.text).foundBy).toEqual([]);
  });

  it("lists none when the retriever does not report", () => {
    const bare = toWireInspection({ ...retrieval, retrievers: [] }, prompt, true);
    expect(bare.candidates.every((c) => c.foundBy.length === 0)).toBe(true);
  });

  it("credits a parent chunk to the retrievers that found its children", () => {
    const parent = chunkOf("Embeddings map text to vectors.\nSimilar meanings sit close together.");
    const child = { ...A, parentId: parent.id };
    const report: RetrievalReport = {
      candidates: [hit(parent, 1, 0.5, "hybrid+parents")],
      ranked: [hit(parent, 1, 0.5, "hybrid+parents")],
      retrievers: [{ name: "dense", results: [hit(child, 3, 0.7, "dense")] }],
    };
    const inspected = toWireInspection(report, { ...prompt, included: [], dropped: [] }, true);
    expect(inspected.candidates[0]?.foundBy).toEqual([{ retriever: "dense", rank: 3, score: 0.7 }]);
  });

  it("counts a retriever that searched twice once, by its best rank", () => {
    const twice: RetrievalReport = {
      ...retrieval,
      retrievers: [
        { name: "dense", results: [hit(A, 5, 0.1, "dense")] },
        { name: "dense", results: [hit(A, 2, 0.6, "dense")] },
      ],
    };
    expect(byText(toWireInspection(twice, prompt, true), A.text).foundBy).toEqual([
      { retriever: "dense", rank: 2, score: 0.6 },
    ]);
  });
});

describe("toWireInspection: the prompt", () => {
  const { retrieval, prompt } = scenario();

  it("carries the prompt as it was assembled, with its token use", () => {
    expect(toWireInspection(retrieval, prompt, true).prompt).toEqual({
      version: "rag-system@v2",
      system: "SYSTEM",
      user: "What is an embedding?",
      sourceTokens: 80,
      budget: 100,
      sent: true,
    });
  });

  it("says the prompt was not sent when the book refused to answer", () => {
    expect(toWireInspection(retrieval, prompt, false).prompt.sent).toBe(false);
  });

  it("is in the contract's shape", () => {
    expect(wireInspectionSchema.safeParse(toWireInspection(retrieval, prompt, true)).success).toBe(
      true,
    );
  });

  it("is in the contract's shape for an answer with no sources at all", () => {
    const empty = toWireInspection(
      { candidates: [], ranked: [], retrievers: [] },
      { ...prompt, included: [], dropped: [], sourceTokens: 0 },
      false,
    );
    expect(wireInspectionSchema.safeParse(empty).success).toBe(true);
    expect(empty.candidates).toEqual([]);
  });
});

describe("snippetOf", () => {
  it("folds whitespace onto one line", () => {
    expect(snippetOf("a\n\n  b\tc ")).toBe("a b c");
  });

  it("cuts a long text to the limit, ending with an ellipsis", () => {
    const cut = snippetOf("word ".repeat(200));
    expect(cut).toHaveLength(SNIPPET_CHARS);
    expect(cut.endsWith("…")).toBe(true);
  });

  it("leaves a text at the limit as it is", () => {
    const exact = "x".repeat(SNIPPET_CHARS);
    expect(snippetOf(exact)).toBe(exact);
  });
});

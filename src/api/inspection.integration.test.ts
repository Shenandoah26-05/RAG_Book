import { describe, expect, it } from "vitest";
import type {
  AssembledPrompt,
  ContextAssembler,
  LlmProvider,
  Reranker,
  RetrievedChunk,
  Retriever,
} from "../core/index.js";
import { RagPipeline } from "../pipeline/index.js";
import { HybridRetriever, ProbedRetriever, RrfFusion } from "../strategies/index.js";
import { makeCandidates } from "../testing/reranker-contract.testing.js";
import { toWireInspection } from "./inspection.js";

// The inspector with the real parts that matter to it: a real hybrid retriever fusing two probed
// retrievers inside a real pipeline. Only the retrievers' rankings, the reranker, the assembler and
// the model are stand-ins. This is what shows that "which retriever found it" survives fusion.

const [A, B, C, D] = makeCandidates(["alpha", "bravo", "charlie", "delta"]);
if (A === undefined || B === undefined || C === undefined || D === undefined)
  throw new Error("setup");

const ranked = (name: string, chunks: readonly RetrievedChunk[]): Retriever => ({
  name,
  retrieve: () =>
    Promise.resolve(
      chunks.map((r, i) => ({ chunk: r.chunk, score: 10 - i, rank: i + 1, retriever: name })),
    ),
});

/** Puts the last candidate first, keeps three: so something moves and something is cut. */
const lastFirst: Reranker = {
  name: "last-first",
  rerank: (_q, candidates, { k }) =>
    Promise.resolve(
      [...candidates]
        .reverse()
        .slice(0, k)
        .map((r, i) => ({ ...r, rank: i + 1, score: 100 - i })),
    ),
};

/** Uses the first two, drops the rest as over budget. */
const twoFit: ContextAssembler = {
  assemble: (query, chunks): AssembledPrompt => ({
    system: "SYSTEM",
    user: query.text,
    promptVersion: "test@v1",
    included: chunks.slice(0, 2),
    citations: [],
    dropped: chunks.slice(2).map((chunk) => ({ chunk, reason: "over-budget" as const })),
    sourceTokens: 12,
    budget: 50,
  }),
};

const llm: LlmProvider = {
  modelId: "fake",
  // eslint-disable-next-line @typescript-eslint/require-await
  async *chat() {
    yield { kind: "end", reason: "stop" } as const;
  },
};

describe("the inspection of a hybrid pipeline", () => {
  const pipeline = new RagPipeline({
    transformer: { name: "identity", transform: (q) => Promise.resolve(q) },
    retriever: new HybridRetriever({
      // dense finds A, B, C in that order; bm25 finds C, D
      retrievers: [
        new ProbedRetriever(ranked("dense", [A, B, C])),
        new ProbedRetriever(ranked("bm25", [C, D])),
      ],
      fusion: new RrfFusion(),
    }),
    reranker: lastFirst,
    rerankCandidates: 4,
    assembler: twoFit,
    llm,
    k: 3,
  });

  it("tells, for each fused chunk, which retrievers found it and at what rank", async () => {
    const answer = await pipeline.ask("question");
    const { candidates } = toWireInspection(answer.retrieval, answer.prompt, true);

    const found = new Map(candidates.map((c) => [c.snippet, c.foundBy]));
    expect(found.get("alpha")).toEqual([{ retriever: "dense", rank: 1, score: 10 }]);
    expect(found.get("charlie")).toEqual([
      { retriever: "bm25", rank: 1, score: 10 },
      { retriever: "dense", rank: 3, score: 8 },
    ]);
    expect(found.get("delta")).toEqual([{ retriever: "bm25", rank: 2, score: 9 }]);
  });

  it("names the hybrid as the retriever that handed the fused chunks on", async () => {
    const answer = await pipeline.ask("question");
    const { candidates } = toWireInspection(answer.retrieval, answer.prompt, true);
    expect(new Set(candidates.map((c) => c.retriever))).toEqual(new Set(["hybrid"]));
  });

  it("follows each chunk through reranking into the prompt or out of it", async () => {
    const answer = await pipeline.ask("question");
    const { candidates } = toWireInspection(answer.retrieval, answer.prompt, true);

    expect(candidates).toHaveLength(4);
    expect(candidates.filter((c) => c.fate === "used")).toHaveLength(2);
    expect(candidates.filter((c) => c.fate === "over-budget")).toHaveLength(1);
    expect(candidates.filter((c) => c.fate === "cut")).toHaveLength(1);
    // the reranker's scores are on its own scale, not retrieval's
    for (const c of candidates.filter((c) => c.finalRank !== null)) {
      expect(c.finalScore).toBeGreaterThan(90);
    }
  });

  it("keeps two questions asked at once from mixing their retrievers", async () => {
    const [first, second] = await Promise.all([pipeline.ask("one"), pipeline.ask("two")]);
    expect(first.retrieval.retrievers.map((r) => r.name).sort()).toEqual(["bm25", "dense"]);
    expect(second.retrieval.retrievers.map((r) => r.name).sort()).toEqual(["bm25", "dense"]);
  });
});

// Hand-made inspections for the tests of the inspector. Nothing in the app imports this.
import type { AskEvent, WireCandidate, WireInspection } from "@rag-book/api-contract";

const id = (letter: string): string => letter.repeat(64);

/** A candidate that reached the prompt at the place retrieval ranked it. */
export const candidate = (extra: Partial<WireCandidate> = {}): WireCandidate => ({
  chunkId: id("a"),
  pageStart: 3,
  pageEnd: 3,
  sectionPath: ["Embeddings", "Similarity"],
  snippet: "Cosine similarity compares direction.",
  rank: 1,
  score: 0.0312,
  retriever: "hybrid",
  foundBy: [{ retriever: "dense", rank: 1, score: 0.91 }],
  finalRank: 1,
  finalScore: 7.5,
  fate: "used",
  source: 1,
  ...extra,
});

/**
 * Four chunks from a hybrid retriever. The reranker moves "Cosine" up from 2 to 1 and "Embeddings"
 * down from 1 to 2, keeps "Stores" third, and drops "Pooling". The prompt fits two of them.
 */
export function inspection(extra: Partial<WireInspection> = {}): WireInspection {
  return {
    candidates: [
      candidate({
        chunkId: id("a"),
        rank: 1,
        score: 0.033,
        snippet: "Embeddings map text to vectors.",
        pageStart: 1,
        pageEnd: 2,
        foundBy: [
          { retriever: "bm25", rank: 1, score: 3.2 },
          { retriever: "dense", rank: 2, score: 0.8 },
        ],
        finalRank: 2,
        finalScore: 5,
        source: 2,
      }),
      candidate({
        chunkId: id("b"),
        rank: 2,
        score: 0.032,
        snippet: "Cosine similarity compares the direction of two vectors.",
        foundBy: [{ retriever: "dense", rank: 1, score: 0.9 }],
        finalRank: 1,
        finalScore: 7,
        source: 1,
      }),
      candidate({
        chunkId: id("c"),
        rank: 3,
        score: 0.016,
        snippet: "A vector store keeps vectors and finds the nearest ones.",
        pageStart: 9,
        pageEnd: 9,
        sectionPath: [],
        foundBy: [{ retriever: "bm25", rank: 2, score: 2.1 }],
        finalRank: 3,
        finalScore: 3,
        fate: "over-budget",
        source: undefined,
      }),
      candidate({
        chunkId: id("d"),
        rank: 4,
        score: 0.005,
        snippet: "Pooling averages token vectors.",
        foundBy: [],
        finalRank: null,
        finalScore: null,
        fate: "cut",
        source: undefined,
      }),
    ].map(({ source, ...rest }) => (source === undefined ? rest : { ...rest, source })),
    prompt: {
      version: "rag-system@v2",
      system: "You answer from the sources. [1] ...",
      user: "What is an embedding?",
      sourceTokens: 80,
      budget: 100,
      sent: true,
    },
    ...extra,
  };
}

export const inspectionEvent = (extra: Partial<WireInspection> = {}): AskEvent => ({
  event: "inspection",
  data: { inspection: inspection(extra) },
});

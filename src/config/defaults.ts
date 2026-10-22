import type { RagConfig } from "./schema.js";

/**
 * The baseline every other source overrides. A config file only needs to list what it changes, so
 * an experiment variant can be a three-line file.
 */
export const DEFAULT_CONFIG: RagConfig = {
  // Order matters: unicode first so later cleaners see normal text (and soft hyphens at line ends
  // become real hyphens); page numbers and headers before de-hyphenation so nothing sits between
  // the two halves of a split word.
  ingestion: {
    loader: "pdfjs",
    cleaners: ["unicode", "page-numbers", "headers-footers", "dehyphenate"],
  },
  chunking: { strategy: "recursive", tokenizer: "approx", maxTokens: 400, overlapTokens: 60 },
  embedding: { provider: "ollama", model: "all-minilm", batchSize: 32 },
  vectorStore: { type: "in-memory", dir: "data/index" },
  retrieval: { strategy: "hybrid", k: 5, fusion: "rrf" },
  rerank: { enabled: false, strategy: "llm", candidates: 20, concurrency: 4 },
  // rewrite: turn a follow-up into a standalone question using the last `historyTurns` turns (only
  // when there is history). hyde and multiQuery are experiments and cost an extra model call each.
  queryTransform: {
    rewrite: true,
    historyTurns: 4,
    hyde: false,
    multiQuery: false,
    multiQueryCount: 3,
  },
  generation: {
    provider: "ollama",
    model: "llama3.2",
    temperature: 0.2,
    maxOutputTokens: 1024,
    contextBudgetTokens: 3000,
    ordering: "sandwich",
  },
  // Same model as the generator so it works with one model pulled. For real results use another
  // model: a judge grades its own writing too kindly (see docs/design/rag-082).
  judge: { provider: "ollama", model: "llama3.2", maxOutputTokens: 700 },
  // 0: do not refuse on score. A good value depends on the scale of the retriever (cosine,
  // fused RRF scores) or reranker in use, so it is set per setup, not guessed here.
  grounding: { minScore: 0 },
};

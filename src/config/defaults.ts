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
  chunking: { strategy: "recursive", maxTokens: 400, overlapTokens: 60 },
  embedding: { provider: "ollama", model: "all-minilm", batchSize: 32 },
  vectorStore: { type: "in-memory", dir: "data/index" },
  retrieval: { strategy: "hybrid", k: 5, fusion: "rrf" },
  rerank: { enabled: false, strategy: "llm", candidates: 20 },
  generation: {
    provider: "ollama",
    model: "llama3.2",
    contextBudgetTokens: 3000,
    ordering: "sandwich",
  },
};

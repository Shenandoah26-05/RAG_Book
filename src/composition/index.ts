// Public API of src/composition. Named exports only.
export { buildChunker, ChunkerRegistry } from "./chunker-registry.js";
export type { ChunkerBuildContext, ChunkerFactory, ChunkerSettings } from "./chunker-registry.js";
export { buildChunkerRegistry } from "./build-chunkers.js";
export { buildInspect, DEFAULT_SAMPLES } from "./build-inspect.js";
export type {
  BuildInspectOptions,
  InspectOptions,
  InspectResult,
  Inspector,
} from "./build-inspect.js";
export { describeInspection } from "./inspect-summary.js";
export { buildIndexer } from "./build-indexer.js";
export type { BuildIndexerOptions, IndexRunOptions, Indexer } from "./build-indexer.js";
export {
  buildEmbedder,
  DEFAULT_EMBEDDING_CACHE_DIR,
  embedderNames,
  parseEmbedderSpec,
} from "./build-embedder.js";
export type { BuildEmbedderOptions } from "./build-embedder.js";
export { describeIndex } from "./index-summary.js";
export { buildDoctor } from "./build-doctor.js";
export type { BuildDoctorOptions, Doctor } from "./build-doctor.js";
export { buildIngest, DEFAULT_PROCESSED_DIR } from "./build-ingest.js";
export type { BuildIngestOptions, Ingester } from "./build-ingest.js";
export {
  buildCleaner,
  buildLoader,
  buildTokenizer,
  cleanerNames,
  loaderNames,
  tokenizerNames,
} from "./registries.js";
export { buildVectorStore, SQLITE_INDEX_FILE, vectorStoreNames } from "./build-vector-store.js";
export {
  buildReranker,
  buildRerankingRetriever,
  rerankerNames,
  resolveRerank,
} from "./build-reranker.js";
export { RERANK_PROMPT_FILE } from "./build-reranker.js";
export type { RerankContext, RerankPlan } from "./build-reranker.js";
export { buildLlmProvider, llmProviderNames } from "./build-llm-provider.js";
export type { BuildLlmProviderOptions } from "./build-llm-provider.js";
export { buildPipeline, DEFAULT_PROMPTS_DIR, PROMPT_FILE } from "./build-pipeline.js";
export type { BuildPipelineOptions } from "./build-pipeline.js";
export { buildSearcher } from "./build-searcher.js";
export type {
  BuildSearcherOptions,
  RetrieverTrace,
  SearchOptions,
  SearchReport,
  Searcher,
} from "./build-searcher.js";
export { describeFilter, describeSearch, searchToJson } from "./search-summary.js";
export {
  buildRetriever,
  fusionNames,
  retrievalStrategyNames,
  usesEmbedder,
} from "./build-retriever.js";
export type { BuildRetrieverOptions } from "./build-retriever.js";
export { loadIndex } from "./load-index.js";
export type { LoadedIndex } from "./load-index.js";
export { DEFAULT_VARIANTS_DIR, listVariants, resolveVariant } from "./variants.js";

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
  RERANK_PROMPT_FILE,
  rerankerNames,
  resolveRerank,
} from "./build-reranker.js";
export type { RerankContext, RerankPlan } from "./build-reranker.js";
export { buildLlmProvider, llmProviderNames } from "./build-llm-provider.js";
export type { BuildLlmProviderOptions } from "./build-llm-provider.js";
export {
  buildPipeline,
  buildPipelineWithConfig,
  DEFAULT_PROMPTS_DIR,
  PROMPT_FILE,
} from "./build-pipeline.js";
export type { BuildPipelineOptions, BuiltPipeline } from "./build-pipeline.js";
export { buildChat } from "./build-chat.js";
export type { BuildChatOptions } from "./build-chat.js";
export {
  CHAT_HELP,
  citedNumbers,
  describeChatConfig,
  describeSources,
  describeTrace,
} from "./chat-format.js";
export type { ChatConfigInfo } from "./chat-format.js";
export { ChatSession } from "./chat-session.js";
export type { ChatOutput, ChatResult, ChatSessionOptions } from "./chat-session.js";
export { buildRetriever, fusionNames, retrieverNames, usesEmbedder } from "./build-retriever.js";
export type { RetrieverContext } from "./build-retriever.js";
export { loadIndex, openIndex } from "./load-index.js";
export type { LoadedIndex, OpenedIndex } from "./load-index.js";
export { buildSearcher } from "./build-searcher.js";
export type {
  BuildSearcherOptions,
  RetrieverTrace,
  SearchOptions,
  SearchReport,
  Searcher,
} from "./build-searcher.js";
export { describeFilter, describeSearch, searchToJson } from "./search-summary.js";
export { argvWithVariant, DEFAULT_VARIANTS_DIR, listVariants, resolveVariant } from "./variants.js";
export { buildAnswerJudge } from "./build-answer-judge.js";
export type { BuildAnswerJudgeOptions } from "./build-answer-judge.js";
export { buildExperiment, DEFAULT_RESULTS_DIR, indexDirFor } from "./build-experiment.js";
export type {
  BuildExperimentOptions,
  EnsureIndex,
  EnsuredIndex,
  Experiment,
  ExperimentPlan,
} from "./build-experiment.js";
export { describePlan, describeSummary } from "./experiment-summary.js";
export { buildReport } from "./build-report.js";
export type { BuildReportOptions, Report } from "./build-report.js";
export { Resilience } from "./build-resilience.js";
export type { ResilienceOptions } from "./build-resilience.js";
export { describeUsage, formatMoney, hasPrices } from "./usage-format.js";

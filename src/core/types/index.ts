// Public API of src/core/types. Named exports only.
export type { Brand, ChunkId, ChunkIdParts, DocId } from "./ids.js";
export { contentHash, makeChunkId } from "./ids.js";
export { PAGE_SEPARATOR } from "./document.js";
export type { CharSpan, Page, ParsedDocument, Section, TextItem } from "./document.js";
export type { Chunk, ChunkMetadata } from "./chunk.js";
export type { FilterClause, FilterableField, MetadataFilter } from "./filter.js";
export type { RetrievedChunk, ScoredChunk, ScoredId, VectorRecord } from "./retrieval.js";
export type {
  ChatDelta,
  ChatMessage,
  ChatOptions,
  ChatRole,
  Citation,
  ConversationTurn,
  FinishReason,
  Query,
} from "./chat.js";
export { INDEX_MANIFEST_VERSION } from "./index-manifest.js";
export type { IndexManifest } from "./index-manifest.js";
export type { AssembledPrompt, DropReason, DroppedChunk, PromptTemplate } from "./prompt.js";
export type {
  AnswerJudgement,
  ClaimVerdict,
  FaithfulnessJudgement,
  JudgeInput,
  ScoredJudgement,
} from "./judgement.js";
export type {
  ExperimentSummary,
  GenerationScores,
  QuestionResult,
  ResultUsage,
  ResultProvenance,
  RetrievalScores,
  RetrievedRecord,
  VariantCost,
  VariantSummary,
} from "./experiment.js";
export type { FeedbackEntry, FeedbackRating } from "./feedback.js";

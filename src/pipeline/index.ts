// Public API of src/pipeline. Named exports only.
export { hasModel, runDoctor } from "./doctor.js";
export type { CheckResult, CheckStatus, RequiredModel } from "./doctor.js";
export { ingest } from "./ingest.js";
export type { IngestDeps, IngestOptions, IngestResult } from "./ingest.js";
export { buildIndex } from "./build-index.js";
export type { IndexDeps, IndexOptions, IndexResult, IndexSettings } from "./build-index.js";
export { indexNamespace } from "./index-namespace.js";
export { RagPipeline, readAnswer, STAGES } from "./rag-pipeline.js";
export type { AskOptions, RagAnswer, RagPipelineDeps } from "./rag-pipeline.js";
export type { AnswerPipeline } from "./answer-pipeline.js";
export { citedNumbers, GroundedPipeline, NOT_FOUND_MESSAGE } from "./grounded-pipeline.js";
export type {
  GroundedAnswer,
  GroundedPipelineDeps,
  GroundingReport,
  RefusalReason,
} from "./grounded-pipeline.js";

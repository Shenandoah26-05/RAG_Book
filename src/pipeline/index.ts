// Public API of src/pipeline. Named exports only.
export { hasModel, runDoctor } from "./doctor.js";
export type { CheckResult, CheckStatus, RequiredModel } from "./doctor.js";
export { ingest } from "./ingest.js";
export type { IngestDeps, IngestOptions, IngestResult } from "./ingest.js";
export { buildIndex } from "./build-index.js";
export type { IndexDeps, IndexOptions, IndexResult, IndexSettings } from "./build-index.js";
export { indexNamespace } from "./index-namespace.js";

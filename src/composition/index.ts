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

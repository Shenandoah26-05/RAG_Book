// Public API of src/composition. Named exports only.
export { buildChunker, ChunkerRegistry } from "./chunker-registry.js";
export type { ChunkerBuildContext, ChunkerFactory, ChunkerSettings } from "./chunker-registry.js";
export { buildDoctor } from "./build-doctor.js";
export type { BuildDoctorOptions, Doctor } from "./build-doctor.js";
export { buildIngest, DEFAULT_PROCESSED_DIR } from "./build-ingest.js";
export type { BuildIngestOptions, Ingester } from "./build-ingest.js";
export { buildCleaner, buildLoader, cleanerNames, loaderNames } from "./registries.js";

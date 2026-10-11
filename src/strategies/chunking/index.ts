// Public API of src/strategies/chunking. Named exports only.
export { createChunk, pageRangeOf, sectionPathAt } from "./chunk-builder.js";
export { FixedSizeChunker } from "./fixed-size-chunker.js";
export { StructureAwareChunker } from "./structure-aware-chunker.js";
export type { StructureAwareOptions } from "./structure-aware-chunker.js";

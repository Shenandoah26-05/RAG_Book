// Public API of src/strategies/chunking. Named exports only.
export { createChunk, pageRangeOf, sectionPathAt } from "./chunk-builder.js";
export {
  renderChunkReport,
  renderHistogram,
  renderSummaryLine,
  sampleChunks,
  seedFrom,
} from "./chunk-report.js";
export type { ChunkReportInput } from "./chunk-report.js";
export { DEFAULT_BUCKETS, summarizeChunks } from "./chunk-stats.js";
export type { ChunkStats, HistogramBucket } from "./chunk-stats.js";
export { FixedSizeChunker } from "./fixed-size-chunker.js";
export { StructureAwareChunker } from "./structure-aware-chunker.js";
export type { StructureAwareOptions } from "./structure-aware-chunker.js";
export { RecursiveChunker } from "./recursive-chunker.js";
export type { RecursiveChunkerOptions } from "./recursive-chunker.js";
export { DEFAULT_SEPARATORS } from "./recursive-split.js";
export type { TokenCounter } from "./recursive-split.js";

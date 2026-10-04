// Public API of src/core/types. Named exports only.
export type { Brand, ChunkId, ChunkIdParts, DocId } from "./ids.js";
export { contentHash, makeChunkId } from "./ids.js";
export { PAGE_SEPARATOR } from "./document.js";
export type { CharSpan, Page, ParsedDocument, Section, TextItem } from "./document.js";
export type { Chunk, ChunkMetadata } from "./chunk.js";
export type { ScoredChunk, ScoredId, VectorRecord } from "./retrieval.js";
export type { Citation, Query } from "./chat.js";

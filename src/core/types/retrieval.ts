import type { Chunk, ChunkMetadata } from "./chunk.js";
import type { ChunkId } from "./ids.js";

/** What a vector store holds: an embedding plus the metadata needed to filter on it. */
export interface VectorRecord {
  readonly id: ChunkId;
  /** Treat as immutable: stores and retrievers must not write into it. */
  readonly vector: Float32Array;
  readonly metadata: ChunkMetadata;
}

/** A search hit before the chunk text is loaded. Higher score means more relevant. */
export interface ScoredId {
  readonly id: ChunkId;
  readonly score: number;
}

export interface ScoredChunk {
  readonly chunk: Chunk;
  readonly score: number;
}

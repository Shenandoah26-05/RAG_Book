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

/** A chunk a retriever found for a question, with where it stands in that retriever's ranking. */
export interface RetrievedChunk {
  readonly chunk: Chunk;
  /** Higher is more relevant. Only comparable with scores from the same retriever. */
  readonly score: number;
  /** Position in the result, starting at 1 for the best. */
  readonly rank: number;
  /** The `name` of the retriever that found it, e.g. "dense". */
  readonly retriever: string;
}

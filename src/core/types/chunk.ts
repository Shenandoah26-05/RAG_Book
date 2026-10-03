import type { ChunkId, DocId } from "./ids.js";

export interface ChunkMetadata {
  readonly docId: DocId;
  /** 1-based, inclusive page range the chunk touches. */
  readonly pageStart: number;
  readonly pageEnd: number;
  /** Titles from the chapter down to the deepest section containing the chunk. Empty if unknown. */
  readonly sectionPath: readonly string[];
  /** Half-open character range `[charStart, charEnd)` in `ParsedDocument.text`. */
  readonly charStart: number;
  readonly charEnd: number;
  /** Name of the chunking strategy that produced it, e.g. "recursive". */
  readonly strategy: string;
}

export interface Chunk {
  readonly id: ChunkId;
  readonly text: string;
  readonly metadata: ChunkMetadata;
}

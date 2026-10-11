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
  /** The passage, kept raw: what is shown to the reader and sent to the LLM. */
  readonly text: string;
  /**
   * What the embedder sees, when it should differ from `text`: the structure-aware chunker puts the
   * heading path in front ("Chapter 3 > 3.2 Embeddings"). Absent means "embed `text`".
   */
  readonly embedText?: string;
  readonly metadata: ChunkMetadata;
}

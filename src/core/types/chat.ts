import type { ChunkId, DocId } from "./ids.js";

/** A user question as it enters retrieval. Query transforms produce new `Query` values. */
export interface Query {
  readonly text: string;
}

/** Points an answer back to the passage it came from. */
export interface Citation {
  /** The marker used in the answer text, starting at 1: "[1]". */
  readonly index: number;
  readonly chunkId: ChunkId;
  readonly docId: DocId;
  readonly pageStart: number;
  readonly pageEnd: number;
  readonly charStart: number;
  readonly charEnd: number;
  /** The cited text, for display and highlighting. */
  readonly quote: string;
}

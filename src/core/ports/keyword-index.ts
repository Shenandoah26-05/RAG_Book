import type { Chunk } from "../types/chunk.js";
import type { MetadataFilter } from "../types/filter.js";
import type { ScoredId } from "../types/retrieval.js";

/**
 * Finds chunks by the words they contain, the keyword counterpart of a `VectorStore`. Like the vector
 * store it returns ids and scores only; a `ChunkStore` turns ids back into chunks. The first
 * implementation is BM25 (RAG-051).
 *
 * Rules every keyword index must follow:
 * 1. `add` indexes the given chunks (their `embedText`, else `text`). A chunk id that is already
 *    indexed, or repeated in the batch, is INVALID_ARGUMENT and nothing from the batch is added.
 * 2. `search` returns at most `k` hits that satisfy `filter`, best first, equal scores ordered by id
 *    (ascending). Only chunks that share at least one word with the query are hits, so a query
 *    with no usable words gives none. `k` is a whole number of 1 or more, else INVALID_ARGUMENT.
 * 3. `serialize` gives text that the implementation's own loader turns back into an index that
 *    answers every search identically.
 */
export interface KeywordIndex {
  /** The name used in messages and files, e.g. "bm25". */
  readonly name: string;
  add(chunks: readonly Chunk[]): void;
  search(query: string, k: number, filter?: MetadataFilter): Promise<readonly ScoredId[]>;
  /** How many chunks are indexed. */
  count(): number;
  /** The whole index as text, to be saved next to the vector index. */
  serialize(): string;
}

import type { ChunkId } from "../types/ids.js";
import type { MetadataFilter } from "../types/filter.js";
import type { ScoredId, VectorRecord } from "../types/retrieval.js";

/**
 * Stores embeddings and finds the ones closest to a query vector. It holds vectors and the metadata
 * to filter on, **not text**: a search returns ids and scores, and a separate `ChunkStore` (RAG-041)
 * turns ids back into chunks. That keeps stores small and swappable.
 *
 * Rules every store must follow. The shared contract test checks all of them:
 * 1. Every vector has exactly `dimensions` entries. A record or a query of another length is
 *    rejected with a RagError coded INVALID_ARGUMENT.
 * 2. `upsert` adds new ids and replaces existing ones (vector and metadata). It is all or nothing:
 *    if any record in the batch is invalid, none is stored.
 * 3. `search` returns at most `k` hits that satisfy `filter`, best first. The score is the cosine
 *    similarity, so for the unit-length vectors an `Embedder` returns it equals the dot product.
 *    Equal scores are ordered by id, ascending. The same store and query always give the same hits.
 * 4. `k` is a whole number of 1 or more, otherwise INVALID_ARGUMENT. A filter with an invalid page
 *    range is INVALID_ARGUMENT too. An empty store, or a filter nothing satisfies, gives no hits.
 * 5. `delete` removes the given ids and ignores ids that are not stored.
 */
export interface VectorStore {
  /** Length of every vector. Must equal the `Embedder`'s `dimensions`. */
  readonly dimensions: number;
  /** Adds or replaces records. An empty batch does nothing. */
  upsert(records: readonly VectorRecord[]): Promise<void>;
  /** The `k` stored vectors most similar to `query`, among those that satisfy `filter`. */
  search(query: Float32Array, k: number, filter?: MetadataFilter): Promise<readonly ScoredId[]>;
  /** Removes the records with these ids. Unknown ids are ignored. */
  delete(ids: readonly ChunkId[]): Promise<void>;
  /** How many records are stored. */
  count(): Promise<number>;
}

import type {
  ChunkId,
  ChunkMetadata,
  ExportableVectorStore,
  MetadataFilter,
  ScoredId,
  VectorRecord,
} from "../../core/index.js";
import { RagError } from "../../shared/index.js";
import { dot, norm } from "../ranking/index.js";
import { assertValidFilter, matchesFilter } from "./metadata-filter.js";
import { TopK } from "./top-k.js";

interface Entry {
  readonly vector: Float32Array;
  /** Length of `vector`, worked out once when it is stored. */
  readonly norm: number;
  readonly metadata: ChunkMetadata;
}

const invalid = (message: string): RagError => new RagError("INVALID_ARGUMENT", message);

/**
 * The reference vector store: **exact** search by comparing the query with every stored vector.
 * Every faster store (an approximate index, a database) is checked against this one.
 *
 * - The score is the cosine similarity. The length of each stored vector is computed once when it
 *   is stored and the query's once per search, so a comparison costs one dot product and one
 *   division, and the result is right even for vectors that are not unit length.
 * - The best `k` are kept with a bounded heap (`TopK`) instead of sorting all the scores.
 * - `upsert` checks the whole batch before storing anything, and stores a copy of each vector, so
 *   neither a bad batch nor a caller who later changes its array can damage the index.
 * - It lives in memory only. `records()` lets an adapter save it to disk (RAG-042) without this
 *   class knowing anything about files.
 */
export class FlatVectorStore implements ExportableVectorStore {
  readonly dimensions: number;
  readonly #entries = new Map<ChunkId, Entry>();

  /** @throws RagError INVALID_ARGUMENT if `dimensions` is not a whole number of 1 or more */
  constructor(dimensions: number) {
    if (!Number.isInteger(dimensions) || dimensions < 1) {
      throw invalid(`dimensions must be a whole number of 1 or more, got ${String(dimensions)}`);
    }
    this.dimensions = dimensions;
  }

  upsert(records: readonly VectorRecord[]): Promise<void> {
    try {
      records.forEach((record) => {
        this.#assertUsable(record.vector, `record ${record.id}`);
      });
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    for (const record of records) {
      const vector = Float32Array.from(record.vector);
      this.#entries.set(record.id, { vector, norm: norm(vector), metadata: record.metadata });
    }
    return Promise.resolve();
  }

  search(
    query: Float32Array,
    k: number,
    filter: MetadataFilter = [],
  ): Promise<readonly ScoredId[]> {
    try {
      this.#assertUsable(query, "query");
      const top = new TopK(k);
      assertValidFilter(filter);
      const queryNorm = norm(query);
      for (const [id, entry] of this.#entries) {
        if (!matchesFilter(entry.metadata, filter)) continue;
        const lengths = queryNorm * entry.norm;
        // a vector with no length points nowhere: similarity 0, never NaN
        top.offer(id, lengths === 0 ? 0 : dot(query, entry.vector) / lengths);
      }
      return Promise.resolve(top.results());
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  delete(ids: readonly ChunkId[]): Promise<void> {
    for (const id of ids) this.#entries.delete(id);
    return Promise.resolve();
  }

  count(): Promise<number> {
    return Promise.resolve(this.#entries.size);
  }

  /** Insertion order: a replaced id keeps its original place. */
  *records(): Iterable<VectorRecord> {
    for (const [id, entry] of this.#entries) {
      yield { id, vector: entry.vector, metadata: entry.metadata };
    }
  }

  #assertUsable(vector: Float32Array, what: string): void {
    if (vector.length !== this.dimensions) {
      throw invalid(
        `${what} has ${vector.length.toString()} dimensions, but this store holds ${this.dimensions.toString()}`,
      );
    }
    if (!vector.every(Number.isFinite)) {
      throw invalid(`${what} holds NaN or Infinity`);
    }
  }
}

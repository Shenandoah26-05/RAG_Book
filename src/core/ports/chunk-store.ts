import type { Chunk } from "../types/chunk.js";
import type { ChunkId } from "../types/ids.js";

/**
 * Keeps chunks by id, so the ids a `VectorStore` search returns can be turned back into text. It is
 * separate from the vector store on purpose: vectors stay small and swappable, and chunks that are
 * never searched (the parents of the parent-child strategy, RAG-027) can be stored without a vector.
 *
 * Rules every chunk store must follow:
 * 1. `put` adds new ids and replaces existing ones. An empty batch does nothing.
 * 2. `get` returns one entry per requested id, in the same order, with `undefined` for an id that
 *    is not stored. It never throws for a missing id.
 * 3. `delete` removes the given ids and ignores ids that are not stored.
 */
export interface ChunkStore {
  put(chunks: readonly Chunk[]): Promise<void>;
  get(ids: readonly ChunkId[]): Promise<readonly (Chunk | undefined)[]>;
  delete(ids: readonly ChunkId[]): Promise<void>;
  /** How many chunks are stored. */
  count(): Promise<number>;
}

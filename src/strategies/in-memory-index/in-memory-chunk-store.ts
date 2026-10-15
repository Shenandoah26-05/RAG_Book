import type { Chunk, ChunkId, ChunkStore } from "../../core/index.js";

/** Keeps chunks by id in a map, in memory only. */
export class InMemoryChunkStore implements ChunkStore {
  readonly #chunks = new Map<ChunkId, Chunk>();

  put(chunks: readonly Chunk[]): Promise<void> {
    for (const chunk of chunks) this.#chunks.set(chunk.id, chunk);
    return Promise.resolve();
  }

  get(ids: readonly ChunkId[]): Promise<readonly (Chunk | undefined)[]> {
    return Promise.resolve(ids.map((id) => this.#chunks.get(id)));
  }

  delete(ids: readonly ChunkId[]): Promise<void> {
    for (const id of ids) this.#chunks.delete(id);
    return Promise.resolve();
  }

  count(): Promise<number> {
    return Promise.resolve(this.#chunks.size);
  }
}

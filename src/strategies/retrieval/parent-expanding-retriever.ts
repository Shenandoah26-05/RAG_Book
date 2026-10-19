import type {
  Chunk,
  ChunkId,
  ChunkStore,
  Query,
  RetrieveOptions,
  RetrievedChunk,
  Retriever,
} from "../../core/index.js";
import { RagError } from "../../shared/index.js";

export interface ParentExpandingRetrieverDeps {
  /** Finds the small chunks (the children). Any retriever: dense, keyword or hybrid. */
  readonly inner: Retriever;
  /** Holds the parents, which are stored there without a vector (RAG-027, RAG-034). */
  readonly chunkStore: ChunkStore;
}

/**
 * Small-to-big retrieval: search with small chunks, answer with the larger chunk each came from.
 * Wraps any `Retriever` and replaces every child it finds with its parent.
 *
 *   inner.retrieve --> children --ChunkStore.get(parentIds)--> parents, one per parent, best child's score
 *
 * - A chunk without a `parentId` (a plain chunker's, or a mix of both) is returned as it is, so
 *   wrapping a retriever over an index with no parents changes nothing.
 * - Children of one parent become one result. It keeps the score of its best child, which is the
 *   first one seen because the inner results are best first. Scores stay the inner retriever's, so
 *   they are comparable with it and not with parent-sized text.
 * - The filter is passed to the inner retriever, so it decides which **children** are found. A
 *   parent covers more than its child, so it can lie partly outside a page or section filter: it
 *   is returned as the context of a child that did match.
 * - Because children merge, fewer than `k` results can come back (never more).
 */
export class ParentExpandingRetriever implements Retriever {
  readonly name: string;

  readonly #inner: Retriever;
  readonly #chunkStore: ChunkStore;

  constructor(deps: ParentExpandingRetrieverDeps) {
    this.#inner = deps.inner;
    this.#chunkStore = deps.chunkStore;
    this.name = `${deps.inner.name}+parents`;
  }

  async retrieve(query: Query, options: RetrieveOptions): Promise<readonly RetrievedChunk[]> {
    const found = await this.#inner.retrieve(query, options);

    const parentIds = [
      ...new Set(
        found.flatMap(({ chunk }) => (chunk.parentId === undefined ? [] : [chunk.parentId])),
      ),
    ];
    const parents = new Map<ChunkId, Chunk>();
    if (parentIds.length > 0) {
      const stored = await this.#chunkStore.get(parentIds);
      parentIds.forEach((id, i) => {
        const parent = stored[i];
        // a child pointing at a parent that is gone means the index is damaged
        if (parent === undefined) {
          throw new RagError(
            "INTERNAL",
            `Chunk ${id} is the parent of a retrieved chunk but the chunk store does not have it. ` +
              'The index is inconsistent: rebuild it with "pnpm index --force".',
          );
        }
        parents.set(id, parent);
      });
    }

    const merged: RetrievedChunk[] = [];
    const seen = new Set<ChunkId>();
    for (const { chunk, score } of found) {
      const result = chunk.parentId === undefined ? chunk : parents.get(chunk.parentId);
      if (result === undefined || seen.has(result.id)) continue;
      seen.add(result.id);
      merged.push({ chunk: result, score, rank: merged.length + 1, retriever: this.name });
    }
    return merged;
  }
}

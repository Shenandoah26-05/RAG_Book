import type {
  Chunk,
  ChunkId,
  FusionStrategy,
  Query,
  RankedList,
  RetrieveOptions,
  RetrievedChunk,
  Retriever,
} from "../../core/index.js";
import { RagError } from "../../shared/index.js";
import { assertValidRequest } from "./retrieval-helpers.js";

/** How many chunks each retriever is asked for, unless `k` is larger. */
export const DEFAULT_HYBRID_DEPTH = 50;

export interface HybridRetrieverOptions {
  /** Retrievers to combine, e.g. a dense and a BM25 one. Names must be unique. */
  readonly retrievers: readonly Retriever[];
  /** How their rankings are combined. */
  readonly fusion: FusionStrategy;
  /**
   * Each retriever is asked for `max(k, depth)` chunks, not just `k`: a chunk that is 30th in one
   * ranking and 2nd in another can still win after fusion, but only if the 30th place is fetched.
   */
  readonly depth?: number;
}

/**
 * A retriever made of retrievers (the Composite pattern). It asks each of them the same question
 * with the same filter, at the same time, combines their rankings with a `FusionStrategy` and
 * returns the best `k`. It is itself a `Retriever`, so it can be used anywhere another is, and can
 * even be one of the retrievers of another hybrid.
 *
 * If any retriever fails, the whole query fails with that error: a result that silently dropped
 * half of the hybrid would look right and be worse. Chunks come with the results of the retrievers,
 * so no chunk store is needed here. A result's `score` is the fused score, comparable only within
 * the same result.
 */
export class HybridRetriever implements Retriever {
  readonly name = "hybrid";

  readonly #retrievers: readonly Retriever[];
  readonly #fusion: FusionStrategy;
  readonly #depth: number;

  /** @throws RagError INVALID_ARGUMENT for no retrievers, repeated names, or a bad depth */
  constructor(options: HybridRetrieverOptions) {
    const { retrievers, fusion, depth = DEFAULT_HYBRID_DEPTH } = options;
    if (retrievers.length === 0) {
      throw new RagError("INVALID_ARGUMENT", "A hybrid retriever needs at least one retriever");
    }
    const names = new Set<string>();
    for (const retriever of retrievers) {
      if (names.has(retriever.name)) {
        throw new RagError(
          "INVALID_ARGUMENT",
          `Two retrievers are called "${retriever.name}"; fusion tells them apart by name`,
        );
      }
      names.add(retriever.name);
    }
    if (!Number.isInteger(depth) || depth < 1) {
      throw new RagError(
        "INVALID_ARGUMENT",
        `depth must be a whole number of 1 or more, got ${String(depth)}`,
      );
    }
    this.#retrievers = retrievers;
    this.#fusion = fusion;
    this.#depth = depth;
  }

  async retrieve(query: Query, options: RetrieveOptions): Promise<readonly RetrievedChunk[]> {
    const { k, filter } = options;
    // checked here as well, so a bad request costs no retriever call at all
    assertValidRequest(k, query.text);

    const asked = {
      k: Math.max(k, this.#depth),
      ...(filter === undefined ? {} : { filter }),
    };
    const results = await Promise.all(this.#retrievers.map((r) => r.retrieve(query, asked)));

    const chunks = new Map<ChunkId, Chunk>();
    const lists: RankedList[] = results.map((found, index) => {
      for (const { chunk } of found) if (!chunks.has(chunk.id)) chunks.set(chunk.id, chunk);
      return {
        retriever: (this.#retrievers[index] as Retriever).name,
        hits: found.map(({ chunk, score }) => ({ id: chunk.id, score })),
      };
    });

    return this.#fusion
      .fuse(lists)
      .slice(0, k)
      .map((hit, index) => ({
        chunk: chunks.get(hit.id) as Chunk,
        score: hit.score,
        rank: index + 1,
        retriever: this.name,
      }));
  }
}

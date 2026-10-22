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

/** How many chunks each search is asked for, unless `k` is larger. */
export const DEFAULT_MULTI_QUERY_DEPTH = 20;

export interface MultiQueryRetrieverOptions {
  /** Does each single search. */
  readonly inner: Retriever;
  /** How the rankings of the searches are combined. */
  readonly fusion: FusionStrategy;
  /** Each search is asked for `max(k, depth)` chunks, so a chunk that is 15th in one can still win. */
  readonly depth?: number;
}

/**
 * Searches for the question and for each of its `variants` (other phrasings, a HyDE passage) with
 * the same retriever, at the same time, and fuses the rankings. A decorator: it is a `Retriever`
 * that wraps one, so the pipeline cannot tell it from a plain one.
 *
 * A query without variants costs exactly one search, and the result is the inner retriever's. Only
 * `text` is passed down to the inner retriever, never the history or the variants. If any search
 * fails the whole retrieval fails, as in `HybridRetriever`: dropping a search quietly would look
 * right and be worse. A result's `score` is the fused score, comparable only within one result.
 */
export class MultiQueryRetriever implements Retriever {
  readonly name: string;

  readonly #inner: Retriever;
  readonly #fusion: FusionStrategy;
  readonly #depth: number;

  /** @throws RagError INVALID_ARGUMENT for a bad depth */
  constructor(options: MultiQueryRetrieverOptions) {
    const { inner, fusion, depth = DEFAULT_MULTI_QUERY_DEPTH } = options;
    if (!Number.isInteger(depth) || depth < 1) {
      throw new RagError(
        "INVALID_ARGUMENT",
        `depth must be a whole number of 1 or more, got ${String(depth)}`,
      );
    }
    this.name = `multi-query(${inner.name})`;
    this.#inner = inner;
    this.#fusion = fusion;
    this.#depth = depth;
  }

  async retrieve(query: Query, options: RetrieveOptions): Promise<readonly RetrievedChunk[]> {
    const { k, filter } = options;
    assertValidRequest(k, query.text);

    const texts = distinctTexts(query);
    if (texts.length === 1) {
      const found = await this.#inner.retrieve({ text: query.text }, options);
      return found.map((r) => ({ ...r, retriever: this.name }));
    }

    const asked = {
      k: Math.max(k, this.#depth),
      ...(filter === undefined ? {} : { filter }),
    };
    const results = await Promise.all(texts.map((text) => this.#inner.retrieve({ text }, asked)));

    const chunks = new Map<ChunkId, Chunk>();
    const lists: RankedList[] = results.map((found, index) => {
      for (const { chunk } of found) if (!chunks.has(chunk.id)) chunks.set(chunk.id, chunk);
      return {
        retriever: `search-${(index + 1).toString()}`,
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

/** The question first, then each variant that is not blank and not a copy of one before it. */
function distinctTexts(query: Query): string[] {
  const seen = new Set<string>([query.text.trim().toLowerCase()]);
  const texts = [query.text];
  for (const variant of query.variants ?? []) {
    const key = variant.trim().toLowerCase();
    if (key === "" || seen.has(key)) continue;
    seen.add(key);
    texts.push(variant);
  }
  return texts;
}

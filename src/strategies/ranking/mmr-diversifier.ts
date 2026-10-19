import type { Diversifier, Embedder, RetrievedChunk } from "../../core/index.js";
import { RagError } from "../../shared/index.js";
import { minMaxScale, mmrOrder } from "./mmr.js";
import { cosine } from "./vector-math.js";

export interface MmrDiversifierOptions {
  /** Must be the model that embedded the index, so "alike" means what it meant when indexing. */
  readonly embedder: Embedder;
  /** 1 keeps the retriever's order, 0 only chases variety. 0 to 1, default 0.5. */
  readonly lambda?: number;
}

/**
 * Chooses chunks with Maximal Marginal Relevance (see `mmrOrder`), so the context is not filled
 * with near-duplicates.
 *
 * - **Relevance** is the retriever's own score, scaled to 0 to 1 over the candidates. That keeps
 *   whatever the retriever knew (a hybrid fusion, BM25 term weights) and works for any of them.
 *   With `lambda = 1` the result is exactly the input order.
 * - **Similarity** is the cosine of the chunks' embeddings, with anything below 0 counted as 0:
 *   "opposite" is no more a duplicate than "unrelated" is, and a negative value would turn the
 *   penalty into a reward.
 * - **The vectors** come from embedding the candidates again, as `embedText ?? text`, the text that
 *   was embedded for the index. A `CachingEmbedder` makes that free after the first time, and it
 *   works with any vector store. Only the candidates are embedded: with 20 of them that is one call.
 */
export class MmrDiversifier implements Diversifier {
  readonly name = "mmr";
  readonly lambda: number;
  readonly #embedder: Embedder;

  /** @throws RagError INVALID_ARGUMENT if `lambda` is not a number from 0 to 1 */
  constructor(options: MmrDiversifierOptions) {
    const { embedder, lambda = 0.5 } = options;
    if (!Number.isFinite(lambda) || lambda < 0 || lambda > 1) {
      throw new RagError(
        "INVALID_ARGUMENT",
        `lambda must be a number from 0 to 1, got ${String(lambda)}`,
      );
    }
    this.lambda = lambda;
    this.#embedder = embedder;
  }

  async diversify(
    candidates: readonly RetrievedChunk[],
    k: number,
  ): Promise<readonly RetrievedChunk[]> {
    if (!Number.isInteger(k) || k < 1) {
      throw new RagError(
        "INVALID_ARGUMENT",
        `k must be a whole number of 1 or more, got ${String(k)}`,
      );
    }
    const ids = new Set(candidates.map((c) => c.chunk.id));
    if (ids.size !== candidates.length) {
      throw new RagError("INVALID_ARGUMENT", "A chunk appears twice among the candidates");
    }
    if (candidates.length === 0) return [];

    const vectors = await this.#embedder.embed(
      candidates.map(({ chunk }) => chunk.embedText ?? chunk.text),
      "document",
    );
    if (vectors.length !== candidates.length) {
      throw new RagError(
        "INTERNAL",
        `${this.#embedder.modelId} returned ${vectors.length.toString()} vectors for ${candidates.length.toString()} chunks`,
      );
    }

    const order = mmrOrder(
      minMaxScale(candidates.map((c) => c.score)),
      (i, j) => Math.max(0, cosine(vectors[i] as Float32Array, vectors[j] as Float32Array)),
      k,
      this.lambda,
    );
    return order.map((index, position) => ({
      ...(candidates[index] as RetrievedChunk),
      rank: position + 1,
    }));
  }
}

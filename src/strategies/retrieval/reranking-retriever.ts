import type {
  Query,
  RetrieveOptions,
  RetrievedChunk,
  Reranker,
  Retriever,
} from "../../core/index.js";
import { RagError } from "../../shared/index.js";

export interface RerankingRetrieverDeps {
  readonly retriever: Retriever;
  readonly reranker: Reranker;
  /**
   * How many candidates to fetch for the reranker to choose from. Fewer than `k` means exactly
   * `k`: with reranking off there is nothing to choose from, so nothing extra is fetched.
   */
  readonly candidates: number;
}

/**
 * A retriever that asks another retriever for more chunks than are needed, then lets a reranker
 * pick the best `k`. To the rest of the pipeline it is just a `Retriever`, so the pipeline has no
 * branch for "reranking on or off": the composition root decides which reranker to give it.
 *
 *   question --retriever--> `candidates` chunks --reranker--> best `k`
 *
 * It keeps the wrapped retriever's name, and each result keeps the `retriever` that found it. The
 * filter applies to the candidates, so the reranker never sees a chunk the filter excludes.
 */
export class RerankingRetriever implements Retriever {
  readonly name: string;

  readonly #retriever: Retriever;
  readonly #reranker: Reranker;
  readonly #candidates: number;

  /** @throws RagError INVALID_ARGUMENT if `candidates` is not a whole number of 0 or more */
  constructor(deps: RerankingRetrieverDeps) {
    if (!Number.isInteger(deps.candidates) || deps.candidates < 0) {
      throw new RagError(
        "INVALID_ARGUMENT",
        `candidates must be a whole number of 0 or more, got ${String(deps.candidates)}`,
      );
    }
    this.name = deps.retriever.name;
    this.#retriever = deps.retriever;
    this.#reranker = deps.reranker;
    this.#candidates = deps.candidates;
  }

  async retrieve(query: Query, options: RetrieveOptions): Promise<readonly RetrievedChunk[]> {
    const { k, filter } = options;
    // checked here, before the candidate count could hide a bad `k`
    if (!Number.isInteger(k) || k < 1) {
      throw new RagError(
        "INVALID_ARGUMENT",
        `k must be a whole number of 1 or more, got ${String(k)}`,
      );
    }
    const found = await this.#retriever.retrieve(query, {
      k: Math.max(k, this.#candidates),
      ...(filter === undefined ? {} : { filter }),
    });
    return this.#reranker.rerank(query, found, { k });
  }
}

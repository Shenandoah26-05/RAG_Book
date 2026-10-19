import type {
  ChunkStore,
  Embedder,
  Query,
  RetrieveOptions,
  RetrievedChunk,
  Retriever,
  VectorStore,
} from "../../core/index.js";
import { RagError } from "../../shared/index.js";
import { assertValidRequest, resolveHits } from "./retrieval-helpers.js";

export interface DenseRetrieverDeps {
  /** Must be the model that embedded the index, or the scores mean nothing. */
  readonly embedder: Embedder;
  readonly vectorStore: VectorStore;
  /** Turns the ids a search returns back into chunks. */
  readonly chunkStore: ChunkStore;
}

/**
 * Finds chunks by meaning: embeds the question, asks the vector store for the nearest vectors, then
 * looks the chunks up by id (the id-to-chunk step of the retrieval flow).
 *
 *   question --embed("query")--> vector --search--> [id, score] --ChunkStore.get--> chunks
 *
 * The question has to be embedded by the same model that embedded the chunks. The vectors of two
 * models live in different spaces even when they have the same length, so only the length can be
 * checked here (in the constructor); using the right model is up to whoever builds the retriever.
 */
export class DenseRetriever implements Retriever {
  readonly name = "dense";

  readonly #embedder: Embedder;
  readonly #vectorStore: VectorStore;
  readonly #chunkStore: ChunkStore;

  /** @throws RagError INVALID_ARGUMENT if the embedder and the store use different vector lengths */
  constructor(deps: DenseRetrieverDeps) {
    if (deps.embedder.dimensions !== deps.vectorStore.dimensions) {
      throw new RagError(
        "INVALID_ARGUMENT",
        `Embedder ${deps.embedder.modelId} makes vectors of ${deps.embedder.dimensions.toString()} numbers, ` +
          `but the vector store holds ${deps.vectorStore.dimensions.toString()}. ` +
          "The question must be embedded with the model that built the index.",
      );
    }
    this.#embedder = deps.embedder;
    this.#vectorStore = deps.vectorStore;
    this.#chunkStore = deps.chunkStore;
  }

  async retrieve(query: Query, options: RetrieveOptions): Promise<readonly RetrievedChunk[]> {
    const { k, filter } = options;
    assertValidRequest(k, query.text);

    const [vector, ...extra] = await this.#embedder.embed([query.text], "query");
    if (vector === undefined || extra.length > 0) {
      throw new RagError("INTERNAL", `${this.#embedder.modelId} did not return exactly one vector`);
    }

    const hits = await this.#vectorStore.search(vector, k, filter);
    return resolveHits(hits, this.#chunkStore, this.name);
  }
}

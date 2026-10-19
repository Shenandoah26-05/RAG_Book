import type {
  ChunkStore,
  KeywordIndex,
  Query,
  RetrieveOptions,
  RetrievedChunk,
  Retriever,
} from "../../core/index.js";
import { assertValidRequest, resolveHits } from "./retrieval-helpers.js";

/**
 * Finds chunks by the words of the question: asks the keyword index (BM25) for the best matches,
 * then looks the chunks up by id. The same shape as `DenseRetriever`, with words in place of
 * meaning, so the pipeline cannot tell the two apart.
 *
 * A question that is not blank but has no usable words (only stopwords, say) matches nothing and
 * gives an empty list.
 */
export class Bm25Retriever implements Retriever {
  readonly name = "bm25";

  readonly #index: KeywordIndex;
  readonly #chunkStore: ChunkStore;

  constructor(index: KeywordIndex, chunkStore: ChunkStore) {
    this.#index = index;
    this.#chunkStore = chunkStore;
  }

  async retrieve(query: Query, options: RetrieveOptions): Promise<readonly RetrievedChunk[]> {
    const { k, filter } = options;
    assertValidRequest(k, query.text);
    const hits = await this.#index.search(query.text, k, filter);
    return resolveHits(hits, this.#chunkStore, this.name);
  }
}

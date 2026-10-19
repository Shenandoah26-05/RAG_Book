import type { MetadataFilter } from "../types/filter.js";
import type { Query } from "../types/chat.js";
import type { RetrievedChunk } from "../types/retrieval.js";

export interface RetrieveOptions {
  /** How many chunks to return at most. A whole number of 1 or more. */
  readonly k: number;
  /** Only chunks that satisfy every clause may be returned. Absent or empty allows all. */
  readonly filter?: MetadataFilter;
}

/**
 * Finds the chunks that best answer a question. Dense (by meaning), keyword (BM25) and hybrid
 * retrievers all implement this, so the rest of the pipeline cannot tell them apart and an
 * experiment can swap one for another. A retriever built from other retrievers (hybrid, or a
 * decorator that expands children to parents) is a `Retriever` too.
 *
 * Rules every retriever must follow. The shared contract test checks them:
 * 1. `retrieve` returns at most `k` chunks, best first. Ranks are 1, 2, 3, ... with no gaps, and a
 *    chunk appears once.
 * 2. Scores never increase down the list.
 * 3. Every result names this retriever in `retriever`, which equals `name`.
 * 4. Every chunk satisfies `filter`.
 * 5. `k` that is not a whole number of 1 or more, or a question that is blank, is a RagError coded
 *    INVALID_ARGUMENT. A question nothing matches gives an empty list, not an error.
 * 6. The same index and question give the same result.
 */
export interface Retriever {
  /** Identifies the retriever in results and experiment reports, e.g. "dense". */
  readonly name: string;
  retrieve(query: Query, options: RetrieveOptions): Promise<readonly RetrievedChunk[]>;
}

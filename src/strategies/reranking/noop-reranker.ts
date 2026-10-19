import type { Query, RerankOptions, Reranker, RetrievedChunk } from "../../core/index.js";
import { RagError } from "../../shared/index.js";

/**
 * Reranking switched off: the candidates come back in the order and with the scores they came in
 * with, cut to `k`. It checks its input like any real reranker would, so turning reranking on or
 * off never changes which calls are errors.
 */
export class NoopReranker implements Reranker {
  readonly name = "noop";

  rerank(
    query: Query,
    candidates: readonly RetrievedChunk[],
    options: RerankOptions,
  ): Promise<readonly RetrievedChunk[]> {
    try {
      assertRerankArguments(query, options);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    return Promise.resolve(candidates.slice(0, options.k));
  }
}

/** The checks every reranker makes first. @throws RagError INVALID_ARGUMENT */
export function assertRerankArguments(query: Query, options: RerankOptions): void {
  const { k } = options;
  if (!Number.isInteger(k) || k < 1) {
    throw new RagError(
      "INVALID_ARGUMENT",
      `k must be a whole number of 1 or more, got ${String(k)}`,
    );
  }
  if (query.text.trim() === "") {
    throw new RagError("INVALID_ARGUMENT", "The question is blank");
  }
}

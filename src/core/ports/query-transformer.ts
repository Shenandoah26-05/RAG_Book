import type { Query } from "../types/chat.js";

export interface TransformOptions {
  /** Aborting stops a transformer that calls a model; the call then throws the signal's reason. */
  readonly signal?: AbortSignal;
}

/**
 * Changes the question before retrieval: rewriting a follow-up into a standalone question,
 * expanding it, and so on. It is the first stage of the pipeline (RAG-072). "No transformation" is
 * just another transformer (`IdentityQueryTransformer`), so the pipeline has no branch for it.
 *
 * Transformers chain like cleaners: each gets the `Query` the one before returned, so a chain of
 * them is a `QueryTransformer` too. A transformer keeps the fields it does not change (`history`,
 * `variants`), so the ones after it still see them.
 *
 * Rules every transformer must follow:
 * 1. The result is a `Query` whose text is not blank. A blank question is a RagError coded
 *    INVALID_ARGUMENT.
 * 2. The input is not changed.
 * 3. With nothing to do (a first question has no history to resolve), the query comes back as it
 *    is, and no model is called.
 */
export interface QueryTransformer {
  /** Identifies the transformer in traces and experiment reports, e.g. "identity". */
  readonly name: string;
  transform(query: Query, options?: TransformOptions): Promise<Query>;
}

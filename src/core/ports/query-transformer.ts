import type { Query } from "../types/chat.js";

/**
 * Changes the question before retrieval: rewriting a follow-up into a standalone question,
 * expanding it, and so on. It is the first stage of the pipeline (RAG-072). "No transformation" is
 * just another transformer (`IdentityQueryTransformer`), so the pipeline has no branch for it.
 *
 * Rules every transformer must follow:
 * 1. The result is a `Query` whose text is not blank. A blank question is a RagError coded
 *    INVALID_ARGUMENT.
 * 2. The input is not changed.
 */
export interface QueryTransformer {
  /** Identifies the transformer in traces and experiment reports, e.g. "identity". */
  readonly name: string;
  transform(query: Query): Promise<Query>;
}

import type { Query } from "../types/chat.js";
import type { AssembledPrompt } from "../types/prompt.js";
import type { RetrievedChunk } from "../types/retrieval.js";

/**
 * The augmentation step: turns retrieved chunks into the prompt the model sees. The pipeline
 * (RAG-072) depends on this port, so ordering, budgeting and the prompt wording can change without
 * touching it.
 *
 * Rules every assembler must follow:
 * 1. `citations[i]` describes `included[i]`, and its `index` is `i + 1`: the number the model sees.
 * 2. Every input chunk ends up in exactly one of `included` or `dropped`.
 * 3. `sourceTokens` never exceeds `budget`.
 * 4. The same chunks and question give the same prompt.
 * 5. A blank question is a RagError coded INVALID_ARGUMENT. No chunks is not an error: the prompt
 *    then says there are no sources, and the model is told to admit it has no answer.
 */
export interface ContextAssembler {
  assemble(query: Query, chunks: readonly RetrievedChunk[]): AssembledPrompt;
}

import type { AskOptions, RagAnswer, RagPipeline } from "./rag-pipeline.js";

/**
 * Anything that answers a question the way the `RagPipeline` does. The grounded pipeline wraps one
 * and is one, so a guardrail can be added or left out without the callers noticing.
 */
export interface AnswerPipeline {
  /** The names of the parts, for `/config` and for reports. */
  describe(): ReturnType<RagPipeline["describe"]>;
  ask(question: string, options?: AskOptions): Promise<RagAnswer>;
}

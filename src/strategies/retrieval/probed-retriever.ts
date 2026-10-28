import type { Query, RetrieveOptions, RetrievedChunk, Retriever } from "../../core/index.js";
import { currentProbe } from "../../shared/index.js";

/**
 * Lets the inspector (RAG-105) see what a retriever found on its own. After each search it hands the
 * results to the probe of the question being answered, if there is one, and returns them unchanged
 * under the same name. Outside a question (no probe in scope) it does nothing extra.
 *
 * Unlike `ObservedRetriever` it is built once with the pipeline and serves many questions: where the
 * results go is found per call, not fixed at construction. A failed search records nothing and the
 * error is rethrown unchanged.
 */
export class ProbedRetriever implements Retriever {
  readonly name: string;

  readonly #inner: Retriever;

  constructor(inner: Retriever) {
    this.name = inner.name;
    this.#inner = inner;
  }

  async retrieve(query: Query, options: RetrieveOptions): Promise<readonly RetrievedChunk[]> {
    const results = await this.#inner.retrieve(query, options);
    currentProbe()?.record(this.name, results);
    return results;
  }
}

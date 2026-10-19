import type { Query, RetrieveOptions, RetrievedChunk, Retriever } from "../../core/index.js";
import type { Trace } from "../../shared/index.js";

/**
 * Lets someone watch a retriever without changing what it does. Every call is recorded as a stage
 * in the `Trace` (its start, how long it took, how many chunks it found), and the results are handed
 * to `onResults`. It returns exactly what the wrapped retriever returned and keeps its name.
 *
 * This is how the search command can show what each retriever of a hybrid found on its own: each one
 * is wrapped, the hybrid runs as usual, and the wrapped retrievers report as they finish. Because a
 * hybrid asks its retrievers at the same time, their stages overlap in the trace.
 *
 * A failed call is recorded as an error stage and the error is rethrown unchanged.
 */
export class ObservedRetriever implements Retriever {
  readonly name: string;

  readonly #inner: Retriever;
  readonly #trace: Trace;
  readonly #onResults: (retriever: string, results: readonly RetrievedChunk[]) => void;

  constructor(
    inner: Retriever,
    trace: Trace,
    onResults: (retriever: string, results: readonly RetrievedChunk[]) => void,
  ) {
    this.name = inner.name;
    this.#inner = inner;
    this.#trace = trace;
    this.#onResults = onResults;
  }

  async retrieve(query: Query, options: RetrieveOptions): Promise<readonly RetrievedChunk[]> {
    const results = await this.#trace.run(
      this.name,
      () => this.#inner.retrieve(query, options),
      (found) => ({ chunks: found.length }),
    );
    this.#onResults(this.name, results);
    return results;
  }
}

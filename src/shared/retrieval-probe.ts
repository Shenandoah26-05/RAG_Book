import { AsyncLocalStorage } from "node:async_hooks";
import type { RetrievedChunk } from "../core/index.js";

/** One search a base retriever made for the question, as it ended. */
export interface RetrieverCall {
  /** The retriever's `name`, e.g. "dense" or "bm25". The same name twice means two searches (variants). */
  readonly name: string;
  /** What it found on its own, before fusion, parent expansion and reranking. */
  readonly results: readonly RetrievedChunk[];
}

/**
 * Collects what each base retriever found for one question, so the inspector (RAG-105) can say which
 * retriever found a chunk once a hybrid has fused them under one name. A `ProbedRetriever` records
 * into the probe in scope; the pipeline opens the scope and reads the calls when retrieval is over.
 */
export class RetrievalProbe {
  readonly #calls: RetrieverCall[] = [];

  record(name: string, results: readonly RetrievedChunk[]): void {
    this.#calls.push({ name, results });
  }

  /** In the order the searches finished. */
  get calls(): readonly RetrieverCall[] {
    return [...this.#calls];
  }
}

const scope = new AsyncLocalStorage<RetrievalProbe>();

/**
 * Runs `fn` with `probe` as the probe of the work it starts, the same way `withTrace` scopes a trace:
 * nothing between the pipeline and the base retrievers has to carry it along, and concurrent
 * questions each keep their own.
 */
export function withProbe<T>(probe: RetrievalProbe, fn: () => T): T {
  return scope.run(probe, fn);
}

/** The probe of the question being answered, or undefined outside one. */
export function currentProbe(): RetrievalProbe | undefined {
  return scope.getStore();
}

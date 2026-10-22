import { AsyncLocalStorage } from "node:async_hooks";
import type { Trace } from "./trace.js";

const scope = new AsyncLocalStorage<Trace>();

/**
 * Runs `fn` with `trace` as the trace of the work it starts. Anything that wants to record itself on
 * the trace of the question being answered (a metered model, RAG-093) finds it with `currentTrace`,
 * so no call between the pipeline and the model has to carry it along.
 *
 * The trace follows asynchronous calls made inside `fn`, including concurrent ones. It does **not**
 * follow a lazily-run generator: the body of an `async function*` runs in whoever reads it. Code that
 * starts such a stream must read `currentTrace()` when it is called, as `MeteredProvider.chat` does,
 * not when the stream is read.
 */
export function withTrace<T>(trace: Trace, fn: () => T): T {
  return scope.run(trace, fn);
}

/** The trace of the question being answered, or undefined outside one. */
export function currentTrace(): Trace | undefined {
  return scope.getStore();
}

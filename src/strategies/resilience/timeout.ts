import type {
  ChatDelta,
  ChatMessage,
  ChatOptions,
  EmbedKind,
  Embedder,
  LlmProvider,
} from "../../core/index.js";
import { RagError, systemClock } from "../../shared/index.js";
import type { Clock } from "../../shared/index.js";

export interface TimeoutOptions {
  /** A whole number of milliseconds, 1 or more. */
  readonly timeoutMs: number;
  readonly clock?: Clock;
}

const TIMED_OUT = Symbol("timed out");

function checked(options: TimeoutOptions): number {
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1) {
    throw new RagError(
      "INVALID_ARGUMENT",
      `timeoutMs must be a whole number of 1 or more, got ${String(options.timeoutMs)}`,
    );
  }
  return options.timeoutMs;
}

/** A timeout is a failure that may pass, so it can be retried. */
const timedOut = (what: string): RagError =>
  new RagError("PROVIDER_UNAVAILABLE", what, { retryable: true });

/**
 * Resolves with the outcome of `work`, or `TIMED_OUT` once `ms` have passed. The timer is cleared as
 * soon as `work` settles, so no timer outlives the call.
 */
async function within<T>(
  work: Promise<T>,
  ms: number,
  clock: Clock,
): Promise<T | typeof TIMED_OUT> {
  const cancel = new AbortController();
  const timer = new Promise<typeof TIMED_OUT>((resolve) => {
    clock.sleep(ms, cancel.signal).then(
      () => {
        resolve(TIMED_OUT);
      },
      () => undefined, // cancelled: the work finished first
    );
  });
  try {
    return await Promise.race([work, timer]);
  } finally {
    cancel.abort();
  }
}

/**
 * Gives up on a model that has gone quiet. For a reply, the limit is on **silence**, not on length:
 * the clock restarts with every event, so a long answer that keeps arriving is never cut, while a
 * model that never starts (still loading, or hung) or stops half-way is abandoned after `timeoutMs`.
 *
 * The request is aborted through the signal it was given, so the adapter closes its connection; the
 * wait is also raced against the timer, so a provider that ignores the signal cannot hold the caller.
 * The error is retryable.
 */
export class TimeoutProvider implements LlmProvider {
  readonly #inner: LlmProvider;
  readonly #timeoutMs: number;
  readonly #clock: Clock;

  /** @throws RagError INVALID_ARGUMENT for a timeout that is not a whole number of 1 or more */
  constructor(inner: LlmProvider, options: TimeoutOptions) {
    this.#inner = inner;
    this.#timeoutMs = checked(options);
    this.#clock = options.clock ?? systemClock;
  }

  get modelId(): string {
    return this.#inner.modelId;
  }

  chat(messages: readonly ChatMessage[], options?: ChatOptions): AsyncIterable<ChatDelta> {
    return this.#stream(messages, options);
  }

  async *#stream(
    messages: readonly ChatMessage[],
    options: ChatOptions | undefined,
  ): AsyncGenerator<ChatDelta> {
    const caller = options?.signal;
    caller?.throwIfAborted();
    // aborted by the caller, or by the timer below; the adapter sees one signal
    const request = new AbortController();
    const onCallerAbort = (): void => {
      request.abort(caller?.reason);
    };
    caller?.addEventListener("abort", onCallerAbort, { once: true });

    const reply = this.#inner.chat(messages, { ...options, signal: request.signal });
    const iterator = reply[Symbol.asyncIterator]();
    let abandoned = false;
    try {
      for (;;) {
        const next = await within(iterator.next(), this.#timeoutMs, this.#clock);
        if (next === TIMED_OUT) {
          abandoned = true;
          const error = timedOut(
            `${this.#inner.modelId} sent nothing for ${this.#timeoutMs.toString()} ms`,
          );
          request.abort(error);
          // not awaited: a provider that ignores the signal would hold us here for ever
          void Promise.resolve(iterator.return?.()).catch(() => undefined);
          throw error;
        }
        if (next.done === true) return;
        yield next.value;
      }
    } finally {
      caller?.removeEventListener("abort", onCallerAbort);
      if (!abandoned) await iterator.return?.();
    }
  }
}

/**
 * Gives up on an embedder that takes too long. The port has no way to cancel, so the abandoned call
 * runs on in the background and its result is thrown away; the caller is freed at once. The error
 * is retryable.
 */
export class TimeoutEmbedder implements Embedder {
  readonly #inner: Embedder;
  readonly #timeoutMs: number;
  readonly #clock: Clock;

  /** @throws RagError INVALID_ARGUMENT for a timeout that is not a whole number of 1 or more */
  constructor(inner: Embedder, options: TimeoutOptions) {
    this.#inner = inner;
    this.#timeoutMs = checked(options);
    this.#clock = options.clock ?? systemClock;
  }

  get modelId(): string {
    return this.#inner.modelId;
  }

  get dimensions(): number {
    return this.#inner.dimensions;
  }

  async embed(texts: readonly string[], kind: EmbedKind): Promise<readonly Float32Array[]> {
    const work = this.#inner.embed(texts, kind);
    const result = await within(work, this.#timeoutMs, this.#clock);
    if (result === TIMED_OUT) {
      // a late failure of the abandoned call must not become an unhandled rejection
      work.catch(() => undefined);
      throw timedOut(
        `${this.#inner.modelId} did not answer within ${this.#timeoutMs.toString()} ms`,
      );
    }
    return result;
  }
}

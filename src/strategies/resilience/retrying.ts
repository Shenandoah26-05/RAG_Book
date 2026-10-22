import type {
  ChatDelta,
  ChatMessage,
  ChatOptions,
  EmbedKind,
  Embedder,
  LlmProvider,
} from "../../core/index.js";
import type { Retrier } from "./retrier.js";

/**
 * Tries a model again when it fails for a reason that may pass (see `Retrier`).
 *
 * A reply is a stream, and a stream can only be tried again **before anything has reached the
 * caller**. Once the first event has been passed on, a retry would start the answer over and the
 * reader would see the beginning twice, so a failure after that is thrown as it is. This is the
 * rule the adapters rely on when they say they never retry: the decision is made here, where it can
 * be made correctly.
 */
export class RetryingProvider implements LlmProvider {
  readonly #inner: LlmProvider;
  readonly #retrier: Retrier;

  constructor(inner: LlmProvider, retrier: Retrier) {
    this.#inner = inner;
    this.#retrier = retrier;
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
    const signal = options?.signal;
    for (let failures = 1; ; failures++) {
      signal?.throwIfAborted();
      const iterator = this.#inner.chat(messages, options)[Symbol.asyncIterator]();
      let passedOn = false;
      let finished = false;
      try {
        for (;;) {
          const next = await iterator.next();
          if (next.done === true) {
            finished = true;
            return;
          }
          passedOn = true;
          yield next.value;
        }
      } catch (error) {
        finished = true;
        const delay = passedOn ? undefined : this.#retrier.delayFor(failures, error);
        if (delay === undefined) throw error;
        await this.#retrier.wait(delay, failures, error, signal);
      } finally {
        // the caller stopped early (a `break`): release the connection
        if (!finished) await iterator.return?.();
      }
    }
  }
}

/** Tries an embedder again when it fails for a reason that may pass. The whole call is repeated. */
export class RetryingEmbedder implements Embedder {
  readonly #inner: Embedder;
  readonly #retrier: Retrier;

  constructor(inner: Embedder, retrier: Retrier) {
    this.#inner = inner;
    this.#retrier = retrier;
  }

  get modelId(): string {
    return this.#inner.modelId;
  }

  get dimensions(): number {
    return this.#inner.dimensions;
  }

  embed(texts: readonly string[], kind: EmbedKind): Promise<readonly Float32Array[]> {
    return this.#retrier.run(() => this.#inner.embed(texts, kind));
  }
}

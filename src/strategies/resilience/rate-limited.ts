import type {
  ChatDelta,
  ChatMessage,
  ChatOptions,
  EmbedKind,
  Embedder,
  LlmProvider,
} from "../../core/index.js";
import type { RateLimiter } from "./rate-limiter.js";

/**
 * Makes a model wait its turn at a `RateLimiter`. The turn is taken when the reply is first read and
 * given back when the stream ends, fails or is abandoned, so a long answer holds its place for as
 * long as it is running (which is what a concurrency limit means).
 */
export class RateLimitedProvider implements LlmProvider {
  readonly #inner: LlmProvider;
  readonly #limiter: RateLimiter;

  constructor(inner: LlmProvider, limiter: RateLimiter) {
    this.#inner = inner;
    this.#limiter = limiter;
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
    const release = await this.#limiter.acquire(options?.signal);
    try {
      yield* this.#inner.chat(messages, options);
    } finally {
      release();
    }
  }
}

/** Makes an embedder wait its turn at a `RateLimiter`; the turn is held for the whole call. */
export class RateLimitedEmbedder implements Embedder {
  readonly #inner: Embedder;
  readonly #limiter: RateLimiter;

  constructor(inner: Embedder, limiter: RateLimiter) {
    this.#inner = inner;
    this.#limiter = limiter;
  }

  get modelId(): string {
    return this.#inner.modelId;
  }

  get dimensions(): number {
    return this.#inner.dimensions;
  }

  async embed(texts: readonly string[], kind: EmbedKind): Promise<readonly Float32Array[]> {
    const release = await this.#limiter.acquire();
    try {
      return await this.#inner.embed(texts, kind);
    } finally {
      release();
    }
  }
}

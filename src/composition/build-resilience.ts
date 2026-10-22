import type { RagConfig } from "../config/index.js";
import type { Embedder, LlmProvider } from "../core/index.js";
import type { Clock, Logger } from "../shared/index.js";
import {
  RateLimitedEmbedder,
  RateLimitedProvider,
  RateLimiter,
  Retrier,
  RetryingEmbedder,
  RetryingProvider,
  TimeoutEmbedder,
  TimeoutProvider,
} from "../strategies/index.js";

type Settings = RagConfig["resilience"]["generation"];

export interface ResilienceOptions {
  readonly logger?: Logger;
  /** Replaces the real clock, so a test does not wait. */
  readonly clock?: Clock;
  /** Replaces the jitter, so a test knows the waits. */
  readonly random?: () => number;
}

/**
 * Protects models and embedders from the network, from the `resilience` section of the config. This
 * is the one place that knows how the decorators are stacked; the adapters know nothing of it.
 *
 *   Retrying( RateLimited( Timeout( adapter ) ) )
 *
 * The order matters:
 * - **Timeout innermost**, so it measures the call itself and not the time spent waiting for a turn.
 * - **Rate limit around it**, so every attempt, a retry included, takes a turn: a retry is another
 *   request as far as the provider is concerned.
 * - **Retrying outermost**, so it sees a timeout as a failure to retry, and waits without holding a
 *   turn.
 * Anything set to 0 leaves its layer out, so a configuration that turns everything off adds no
 * wrapper at all.
 *
 * One `Resilience` per run: it owns the rate limiters, one for models and one for embedders, so the
 * answering model, the reranker and the judge, which all call the same service, share its limit.
 */
export class Resilience {
  readonly #config: RagConfig["resilience"];
  readonly #options: ResilienceOptions;
  readonly #limiters = new Map<"generation" | "embedding", RateLimiter | null>();

  constructor(config: RagConfig["resilience"], options: ResilienceOptions = {}) {
    this.#config = config;
    this.#options = options;
  }

  /** The model, wrapped. A model built by `buildLlmProvider` is wrapped there. */
  llm(provider: LlmProvider): LlmProvider {
    const s = this.#config.generation;
    let wrapped = provider;
    if (s.timeoutMs > 0) {
      wrapped = new TimeoutProvider(wrapped, { timeoutMs: s.timeoutMs, ...this.#clock() });
    }
    const limiter = this.#limiter("generation", s);
    if (limiter !== null) wrapped = new RateLimitedProvider(wrapped, limiter);
    if (s.retries > 0) wrapped = new RetryingProvider(wrapped, this.#retrier(s, provider.modelId));
    return wrapped;
  }

  /** The embedder, wrapped. The cache goes outside this, so a cache hit uses no turn and no retry. */
  embedder(embedder: Embedder): Embedder {
    const s = this.#config.embedding;
    let wrapped = embedder;
    if (s.timeoutMs > 0) {
      wrapped = new TimeoutEmbedder(wrapped, { timeoutMs: s.timeoutMs, ...this.#clock() });
    }
    const limiter = this.#limiter("embedding", s);
    if (limiter !== null) wrapped = new RateLimitedEmbedder(wrapped, limiter);
    if (s.retries > 0) {
      wrapped = new RetryingEmbedder(wrapped, this.#retrier(s, embedder.modelId));
    }
    return wrapped;
  }

  #clock(): { clock: Clock } | Record<string, never> {
    return this.#options.clock === undefined ? {} : { clock: this.#options.clock };
  }

  #retrier(s: Settings, label: string): Retrier {
    return new Retrier({
      retries: s.retries,
      baseDelayMs: s.backoffMs,
      maxDelayMs: s.maxBackoffMs,
      label,
      ...this.#clock(),
      ...(this.#options.logger === undefined ? {} : { logger: this.#options.logger }),
      ...(this.#options.random === undefined ? {} : { random: this.#options.random }),
    });
  }

  /** The limiter for a kind of call, made on first use and shared after that; null when no limit is set. */
  #limiter(kind: "generation" | "embedding", s: Settings): RateLimiter | null {
    if (!this.#limiters.has(kind)) {
      this.#limiters.set(
        kind,
        s.requestsPerMinute > 0 || s.maxConcurrent > 0
          ? new RateLimiter({
              requestsPerMinute: s.requestsPerMinute,
              maxConcurrent: s.maxConcurrent,
              ...this.#clock(),
            })
          : null,
      );
    }
    return this.#limiters.get(kind) ?? null;
  }
}

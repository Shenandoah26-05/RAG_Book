import { noopLogger, RagError, systemClock } from "../../shared/index.js";
import type { Clock, Logger } from "../../shared/index.js";

export interface RetrierOptions {
  /** How many times to try again after the first attempt fails. A whole number of 1 or more. */
  readonly retries: number;
  /** The wait before the first retry, before jitter; it doubles with each retry. */
  readonly baseDelayMs: number;
  /** No wait is longer than this, and a server that asks for more is not waited for. */
  readonly maxDelayMs: number;
  readonly clock?: Clock;
  readonly logger?: Logger;
  /** 0 up to (not including) 1. Replaced in tests. */
  readonly random?: () => number;
  /** Names the thing being retried in log lines, e.g. "ollama:llama3.2". */
  readonly label?: string;
}

/** Whether a failure is worth trying again. Only an adapter can tell, so unmarked errors are not. */
export function isRetryable(error: unknown): boolean {
  return error instanceof RagError && error.retryable === true;
}

/**
 * The retry rules, shared by the decorators for a model and for an embedder.
 *
 * - **What is retried:** an error that says it is `retryable` (a dropped connection, a timeout, HTTP
 *   429 or 5xx). A missing model, a wrong key, a malformed reply and an abort are not: trying again
 *   cannot help, and an abort is the caller's decision.
 * - **How long to wait:** exponential with full jitter. The cap doubles each retry (500, 1000, 2000 ...
 *   up to `maxDelayMs`) and the wait is a random point below the cap, so many callers that failed
 *   together do not all come back together. If the server said when to come back (`Retry-After`) the
 *   wait is at least that long, and if that is longer than `maxDelayMs` the call is not retried at
 *   all: the caller cannot wait that long, so it should hear about the failure now.
 */
export class Retrier {
  readonly #retries: number;
  readonly #baseDelayMs: number;
  readonly #maxDelayMs: number;
  readonly #clock: Clock;
  readonly #logger: Logger;
  readonly #random: () => number;
  readonly #label: string;

  /** @throws RagError INVALID_ARGUMENT for a count or delay that is not a whole number in range */
  constructor(options: RetrierOptions) {
    const whole = (name: string, value: number, min: number): void => {
      if (!Number.isInteger(value) || value < min) {
        throw new RagError(
          "INVALID_ARGUMENT",
          `${name} must be a whole number of ${min.toString()} or more, got ${String(value)}`,
        );
      }
    };
    whole("retries", options.retries, 1);
    whole("baseDelayMs", options.baseDelayMs, 0);
    whole("maxDelayMs", options.maxDelayMs, 0);
    if (options.maxDelayMs < options.baseDelayMs) {
      throw new RagError("INVALID_ARGUMENT", "maxDelayMs must be at least baseDelayMs");
    }
    this.#retries = options.retries;
    this.#baseDelayMs = options.baseDelayMs;
    this.#maxDelayMs = options.maxDelayMs;
    this.#clock = options.clock ?? systemClock;
    this.#logger = options.logger ?? noopLogger;
    this.#random = options.random ?? Math.random;
    this.#label = options.label ?? "call";
  }

  /**
   * How long to wait before retry number `attempt` (1 for the first retry) after `error`, or
   * undefined when the call should not be retried: the error is not retryable, the retries are used
   * up, or the server asked for a longer wait than `maxDelayMs`.
   */
  delayFor(attempt: number, error: unknown): number | undefined {
    if (attempt > this.#retries || !isRetryable(error)) return undefined;
    const retryAfter = error instanceof RagError ? error.retryAfterMs : undefined;
    if (retryAfter !== undefined && retryAfter > this.#maxDelayMs) return undefined;
    const cap = Math.min(this.#maxDelayMs, this.#baseDelayMs * 2 ** (attempt - 1));
    return Math.round(Math.max(this.#random() * cap, retryAfter ?? 0));
  }

  /** Waits `ms`, and says so in the log. Rejects with the signal's reason if it aborts. */
  async wait(ms: number, attempt: number, error: unknown, signal?: AbortSignal): Promise<void> {
    this.#logger.warn("retrying after a failure", {
      target: this.#label,
      retry: attempt,
      of: this.#retries,
      waitMs: ms,
      error: error instanceof Error ? error.message : String(error),
    });
    await this.#clock.sleep(ms, signal);
  }

  /** Runs `call`, trying again while `delayFor` says to. The last error is thrown as it is. */
  async run<T>(call: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    for (let failures = 1; ; failures++) {
      signal?.throwIfAborted();
      try {
        return await call();
      } catch (error) {
        const delay = this.delayFor(failures, error);
        if (delay === undefined) throw error;
        await this.wait(delay, failures, error, signal);
      }
    }
  }
}

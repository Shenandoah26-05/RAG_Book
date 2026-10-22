import { RagError, systemClock } from "../../shared/index.js";
import type { Clock } from "../../shared/index.js";

export interface RateLimiterOptions {
  /** At most this many calls may start in any `windowMs`. 0 or absent: no such limit. */
  readonly requestsPerMinute?: number;
  /** At most this many calls may be running at once. 0 or absent: no such limit. */
  readonly maxConcurrent?: number;
  /** The length of the window the rate is counted over. Default one minute; tests use less. */
  readonly windowMs?: number;
  readonly clock?: Clock;
}

interface Waiter {
  readonly resolve: (release: () => void) => void;
  readonly reject: (reason: unknown) => void;
  readonly signal: AbortSignal | undefined;
  readonly onAbort: () => void;
}

const DEFAULT_WINDOW_MS = 60_000;

/**
 * Lets calls through at the pace a provider allows. Two limits, either or both:
 *
 * - **rate:** at most N calls start in any window (a sliding window, not a counter that resets, so a
 *   burst at the end of one minute and the start of the next cannot double the rate);
 * - **concurrency:** at most M calls are running at once.
 *
 * A call that would go over waits its turn, first come first served, and starts as soon as both limits
 * allow. It is not rejected: a pipeline that is told to slow down should slow down, not fail.
 *
 * One limiter is shared by every wrapper of the same service, so the answering model, the reranker
 * and the judge together stay under the one limit that the provider actually applies.
 */
export class RateLimiter {
  readonly #perWindow: number;
  readonly #maxConcurrent: number;
  readonly #windowMs: number;
  readonly #clock: Clock;
  #starts: number[] = [];
  #running = 0;
  #queue: Waiter[] = [];
  #wake: AbortController | undefined;

  /** @throws RagError INVALID_ARGUMENT for a limit that is not a whole number of 0 or more */
  constructor(options: RateLimiterOptions = {}) {
    const { requestsPerMinute = 0, maxConcurrent = 0, windowMs = DEFAULT_WINDOW_MS } = options;
    for (const [name, value, min] of [
      ["requestsPerMinute", requestsPerMinute, 0],
      ["maxConcurrent", maxConcurrent, 0],
      ["windowMs", windowMs, 1],
    ] as const) {
      if (!Number.isInteger(value) || value < min) {
        throw new RagError(
          "INVALID_ARGUMENT",
          `${name} must be a whole number of ${min.toString()} or more, got ${String(value)}`,
        );
      }
    }
    this.#perWindow = requestsPerMinute;
    this.#maxConcurrent = maxConcurrent;
    this.#windowMs = windowMs;
    this.#clock = options.clock ?? systemClock;
  }

  /** Calls waiting for their turn. */
  get waiting(): number {
    return this.#queue.length;
  }

  /**
   * Waits for a turn and returns the function that gives it back. Call it exactly when the call is
   * over, even if it failed (calling it again does nothing). A turn that was never taken because
   * `signal` aborted while waiting rejects with the signal's reason.
   */
  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted === true) return Promise.reject(signal.reason as Error);
    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        signal,
        onAbort: () => {
          this.#queue = this.#queue.filter((w) => w !== waiter);
          if (this.#queue.length === 0) this.#cancelWake();
          reject(signal?.reason as Error);
        },
      };
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
      this.#queue.push(waiter);
      this.#pump();
    });
  }

  #pump(): void {
    for (;;) {
      const next = this.#queue[0];
      if (next === undefined) return;
      if (this.#maxConcurrent > 0 && this.#running >= this.#maxConcurrent) return; // a release pumps
      if (this.#perWindow > 0) {
        const now = this.#clock.now();
        this.#starts = this.#starts.filter((t) => now - t < this.#windowMs);
        if (this.#starts.length >= this.#perWindow) {
          this.#wakeAt((this.#starts[0] as number) + this.#windowMs - now);
          return;
        }
        this.#starts.push(now);
      }
      this.#queue.shift();
      next.signal?.removeEventListener("abort", next.onAbort);
      this.#running++;
      next.resolve(this.#releaser());
    }
  }

  #releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#running--;
      this.#pump();
    };
  }

  /** Looks again when the oldest start leaves the window. One timer at a time. */
  #wakeAt(ms: number): void {
    if (this.#wake !== undefined) return;
    const wake = new AbortController();
    this.#wake = wake;
    this.#clock.sleep(Math.max(0, ms), wake.signal).then(
      () => {
        this.#wake = undefined;
        this.#pump();
      },
      () => undefined,
    );
  }

  #cancelWake(): void {
    this.#wake?.abort();
    this.#wake = undefined;
  }
}

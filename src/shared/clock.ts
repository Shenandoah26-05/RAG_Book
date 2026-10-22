/**
 * Time, as something that can be replaced. Code that waits (a retry, a rate limit, a timeout) asks a
 * `Clock` instead of calling `setTimeout`, so a test can move time by hand and never really sleep.
 */
export interface Clock {
  /** Milliseconds from any fixed starting point; only differences mean anything. */
  now(): number;
  /**
   * Resolves after `ms` milliseconds. If `signal` aborts first, rejects with the signal's reason and
   * the timer is cleared. A signal that is already aborted rejects at once.
   */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

/** The real clock. */
export const systemClock: Clock = {
  now: () => performance.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted === true) {
        reject(signal.reason as Error);
        return;
      }
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(signal?.reason as Error);
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      signal?.addEventListener("abort", onAbort, { once: true });
    }),
};

// A clock that only moves when a test says so. Not part of the build (see tsconfig.build.json).
import type { Clock } from "../shared/index.js";

interface Sleeper {
  readonly due: number;
  readonly resolve: () => void;
  readonly signal: AbortSignal | undefined;
  readonly onAbort: () => void;
}

export class FakeClock implements Clock {
  #now = 0;
  #sleepers: Sleeper[] = [];
  /** Every duration asked for, in order: what a test checks to see how long something waited. */
  readonly sleeps: number[] = [];

  now(): number {
    return this.#now;
  }

  /** How many sleeps are waiting. */
  get pending(): number {
    return this.#sleepers.length;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    this.sleeps.push(ms);
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted === true) {
        reject(signal.reason as Error);
        return;
      }
      const onAbort = (): void => {
        this.#sleepers = this.#sleepers.filter((s) => s.onAbort !== onAbort);
        reject(signal?.reason as Error);
      };
      this.#sleepers.push({ due: this.#now + ms, resolve, signal, onAbort });
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** Moves time forward and wakes every sleep that is now due, earliest first. */
  async advance(ms: number): Promise<void> {
    const target = this.#now + ms;
    for (;;) {
      const next = this.#sleepers.filter((s) => s.due <= target).sort((a, b) => a.due - b.due)[0];
      if (next === undefined) break;
      this.#sleepers = this.#sleepers.filter((s) => s !== next);
      this.#now = Math.max(this.#now, next.due);
      next.signal?.removeEventListener("abort", next.onAbort);
      next.resolve();
      // let whatever was waiting run, and start its next sleep, before the following one wakes
      await settle();
    }
    this.#now = target;
    await settle();
  }
}

/** Lets pending promise callbacks run. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

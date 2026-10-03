import { RagError } from "./errors.js";

/** A short, flat description of what a stage produced: counts, sizes, names. Not the data itself. */
export type TraceSummary = Readonly<Record<string, string | number | boolean | null>>;

export interface StageRecord {
  readonly stage: string;
  /** Milliseconds from the creation of the trace to the start of the stage. */
  readonly startMs: number;
  readonly durationMs: number;
  readonly status: "ok" | "error";
  readonly summary: TraceSummary;
  /** The error message, when `status` is "error". */
  readonly error?: string;
}

export interface TraceSnapshot {
  /** Milliseconds from the creation of the trace to the end of the last stage. */
  readonly totalMs: number;
  readonly stages: readonly StageRecord[];
}

/** An open stage. Close it exactly once, with `end` or `fail`. */
export interface StageHandle {
  end(summary?: TraceSummary): void;
  fail(error: unknown): void;
}

/**
 * Records what each pipeline stage did and how long it took, so a surprising answer can be traced
 * back to the stage that caused it. Stages are listed in the order they finished; use `startMs`
 * to lay them out in time. The clock is injectable so tests do not depend on real time.
 */
export class Trace {
  readonly #now: () => number;
  readonly #origin: number;
  readonly #stages: StageRecord[] = [];

  constructor(now: () => number = () => performance.now()) {
    this.#now = now;
    this.#origin = now();
  }

  /** Opens a stage by hand. Use for work that does not fit in one function, such as a stream. */
  start(stage: string): StageHandle {
    const startedAt = this.#now();
    let closed = false;

    const close = (status: StageRecord["status"], summary: TraceSummary, error?: string): void => {
      if (closed) throw new RagError("INTERNAL", `trace stage "${stage}" was closed twice`);
      closed = true;
      this.#stages.push({
        stage,
        startMs: startedAt - this.#origin,
        durationMs: this.#now() - startedAt,
        status,
        summary,
        ...(error === undefined ? {} : { error }),
      });
    };

    return {
      end: (summary = {}) => {
        close("ok", summary);
      },
      fail: (error) => {
        close("error", {}, error instanceof Error ? error.message : String(error));
      },
    };
  }

  /**
   * Runs `fn` as a stage. `summarize` turns its result into the summary to record. If `fn` throws,
   * the stage is recorded as an error and the error is rethrown unchanged.
   */
  async run<T>(
    stage: string,
    fn: () => T | Promise<T>,
    summarize?: (result: T) => TraceSummary,
  ): Promise<T> {
    const handle = this.start(stage);
    let result: T;
    try {
      result = await fn();
    } catch (error) {
      handle.fail(error);
      throw error;
    }
    handle.end(summarize?.(result));
    return result;
  }

  get stages(): readonly StageRecord[] {
    return [...this.#stages];
  }

  snapshot(): TraceSnapshot {
    const totalMs = this.#stages.reduce(
      (latest, s) => Math.max(latest, s.startMs + s.durationMs),
      0,
    );
    return { totalMs, stages: this.stages };
  }

  toJSON(): TraceSnapshot {
    return this.snapshot();
  }
}

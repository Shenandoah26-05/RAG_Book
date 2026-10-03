import { describe, expect, it } from "vitest";
import { RagError } from "./errors.js";
import { Trace } from "./trace.js";

/** A clock the test moves by hand. */
function fakeClock(start = 1000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("Trace", () => {
  it("starts empty", () => {
    const trace = new Trace(fakeClock().now);
    expect(trace.stages).toEqual([]);
    expect(trace.snapshot()).toEqual({ totalMs: 0, stages: [] });
  });

  it("run records the duration and the summary of the result", async () => {
    const clock = fakeClock();
    const trace = new Trace(clock.now);

    const result = await trace.run(
      "retrieve",
      () => {
        clock.advance(40);
        return ["a", "b", "c"];
      },
      (hits) => ({ count: hits.length }),
    );

    expect(result).toEqual(["a", "b", "c"]);
    expect(trace.stages).toEqual([
      { stage: "retrieve", startMs: 0, durationMs: 40, status: "ok", summary: { count: 3 } },
    ]);
  });

  it("works with async functions and records an empty summary when none is given", async () => {
    const clock = fakeClock();
    const trace = new Trace(clock.now);

    await trace.run("embed", async () => {
      await Promise.resolve();
      clock.advance(25);
    });

    expect(trace.stages[0]).toMatchObject({ stage: "embed", durationMs: 25, summary: {} });
  });

  it("measures start times from the creation of the trace", async () => {
    const clock = fakeClock();
    const trace = new Trace(clock.now);

    clock.advance(10);
    await trace.run("a", () => {
      clock.advance(5);
    });
    clock.advance(20);
    await trace.run("b", () => {
      clock.advance(7);
    });

    expect(trace.stages.map((s) => [s.stage, s.startMs, s.durationMs])).toEqual([
      ["a", 10, 5],
      ["b", 35, 7],
    ]);
    expect(trace.snapshot().totalMs).toBe(42);
  });

  it("records a failing stage as an error and rethrows the original error", async () => {
    const clock = fakeClock();
    const trace = new Trace(clock.now);
    const failure = new Error("model not found");

    await expect(
      trace.run("generate", () => {
        clock.advance(12);
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(trace.stages).toEqual([
      {
        stage: "generate",
        startMs: 0,
        durationMs: 12,
        status: "error",
        summary: {},
        error: "model not found",
      },
    ]);
  });

  it("records a rejected promise as an error too", async () => {
    const trace = new Trace(fakeClock().now);
    await expect(trace.run("x", () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(trace.stages[0]).toMatchObject({ status: "error", error: "boom" });
  });

  it("records non-Error throws as text", async () => {
    const trace = new Trace(fakeClock().now);
    // Rejecting with a string is the point of this test: code we do not control may do it.
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    const rejecting = () => Promise.reject("just a string");
    await expect(trace.run("x", rejecting)).rejects.toBe("just a string");
    expect(trace.stages[0]).toMatchObject({ status: "error", error: "just a string" });
  });

  it("start/end covers work that does not fit in one function", () => {
    const clock = fakeClock();
    const trace = new Trace(clock.now);

    const stage = trace.start("stream");
    clock.advance(300);
    stage.end({ tokens: 120, truncated: false });

    expect(trace.stages).toEqual([
      {
        stage: "stream",
        startMs: 0,
        durationMs: 300,
        status: "ok",
        summary: { tokens: 120, truncated: false },
      },
    ]);
  });

  it("start/fail records an error", () => {
    const trace = new Trace(fakeClock().now);
    trace.start("stream").fail(new Error("connection reset"));
    expect(trace.stages[0]).toMatchObject({ status: "error", error: "connection reset" });
  });

  it("refuses to close a stage twice, and does not record it twice", () => {
    const trace = new Trace(fakeClock().now);
    const stage = trace.start("once");
    stage.end();

    expect(() => {
      stage.end();
    }).toThrow(RagError);
    expect(() => {
      stage.fail(new Error("late"));
    }).toThrow(/closed twice/);
    expect(trace.stages).toHaveLength(1);
  });

  it("lists stages in the order they finished, even when they overlap", () => {
    const clock = fakeClock();
    const trace = new Trace(clock.now);

    const outer = trace.start("outer");
    clock.advance(5);
    const inner = trace.start("inner");
    clock.advance(10);
    inner.end();
    clock.advance(5);
    outer.end();

    expect(trace.stages.map((s) => s.stage)).toEqual(["inner", "outer"]);
    expect(trace.stages[0]).toMatchObject({ startMs: 5, durationMs: 10 });
    expect(trace.stages[1]).toMatchObject({ startMs: 0, durationMs: 20 });
  });

  it("returns copies, so callers cannot change the record", () => {
    const trace = new Trace(fakeClock().now);
    trace.start("a").end();
    const copy = trace.stages as unknown[];
    copy.length = 0;
    expect(trace.stages).toHaveLength(1);
  });

  it("serialises to JSON", async () => {
    const clock = fakeClock();
    const trace = new Trace(clock.now);
    await trace.run("a", () => {
      clock.advance(3);
    });
    expect(JSON.parse(JSON.stringify(trace))).toEqual({
      totalMs: 3,
      stages: [{ stage: "a", startMs: 0, durationMs: 3, status: "ok", summary: {} }],
    });
  });

  it("uses a real clock by default", async () => {
    const trace = new Trace();
    await trace.run("real", () => undefined);
    expect(trace.stages[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });
});

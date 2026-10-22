import { describe, expect, it } from "vitest";
import { RagError, createJsonLogger } from "../../shared/index.js";
import { FakeClock } from "../../testing/fake-clock.testing.js";
import { isRetryable, Retrier } from "./retrier.js";
import { permanent, settled, transient } from "./resilience.testing.js";

const make = (overrides: Partial<ConstructorParameters<typeof Retrier>[0]> = {}) => {
  const clock = new FakeClock();
  return {
    clock,
    retrier: new Retrier({
      retries: 4,
      baseDelayMs: 100,
      maxDelayMs: 1000,
      clock,
      random: () => 1,
      ...overrides,
    }),
  };
};

describe("isRetryable", () => {
  it("is true only for an error that says it is", () => {
    expect(isRetryable(transient())).toBe(true);
    expect(isRetryable(permanent())).toBe(false);
    expect(isRetryable(new RagError("PROVIDER_UNAVAILABLE", "unknown"))).toBe(false);
    expect(isRetryable(new Error("plain"))).toBe(false);
    expect(isRetryable("text")).toBe(false);
  });
});

describe("Retrier.delayFor", () => {
  it("doubles the cap each retry, up to the maximum", () => {
    const { retrier } = make();
    expect([1, 2, 3, 4].map((n) => retrier.delayFor(n, transient()))).toEqual([100, 200, 400, 800]);
    const capped = make({ retries: 6 }).retrier;
    expect([4, 5, 6].map((n) => capped.delayFor(n, transient()))).toEqual([800, 1000, 1000]);
  });

  it("waits a random point below the cap (full jitter)", () => {
    const { retrier } = make({ random: () => 0.25 });
    expect(retrier.delayFor(3, transient())).toBe(100);
    expect(make({ random: () => 0 }).retrier.delayFor(3, transient())).toBe(0);
  });

  it("does not retry what cannot be helped, or when the retries are used up", () => {
    const { retrier } = make();
    expect(retrier.delayFor(1, permanent())).toBeUndefined();
    expect(retrier.delayFor(1, new RagError("PROVIDER_UNAVAILABLE", "unmarked"))).toBeUndefined();
    expect(retrier.delayFor(1, new Error("plain"))).toBeUndefined();
    expect(retrier.delayFor(5, transient())).toBeUndefined();
  });

  it("waits at least as long as the server asked", () => {
    const { retrier } = make({ random: () => 0 });
    const busy = new RagError("PROVIDER_UNAVAILABLE", "429", {
      retryable: true,
      retryAfterMs: 700,
    });
    expect(retrier.delayFor(1, busy)).toBe(700);
  });

  it("gives up at once when the server asks for longer than it will wait", () => {
    const { retrier } = make();
    const busy = new RagError("PROVIDER_UNAVAILABLE", "429", {
      retryable: true,
      retryAfterMs: 1001,
    });
    expect(retrier.delayFor(1, busy)).toBeUndefined();
  });

  it("rejects settings that make no sense", () => {
    for (const bad of [{ retries: 0 }, { retries: 1.5 }, { baseDelayMs: -1 }, { maxDelayMs: 50 }]) {
      expect(() => make(bad)).toThrow(/must be|at least/);
    }
  });
});

describe("Retrier.run", () => {
  it("returns the result of the first attempt that works, waiting between attempts", async () => {
    const { retrier, clock } = make();
    let calls = 0;
    const result = await settled(
      retrier.run(() => {
        calls++;
        return calls < 3 ? Promise.reject(transient()) : Promise.resolve("done");
      }),
      () => clock.advance(10_000),
    );
    expect(result.value).toBe("done");
    expect(calls).toBe(3);
    expect(clock.sleeps).toEqual([100, 200]);
  });

  it("throws the last error as it is when the retries run out", async () => {
    const { retrier, clock } = make({ retries: 2 });
    const errors = [transient("a"), transient("b"), transient("c")];
    let calls = 0;
    const result = await settled(
      retrier.run(() => Promise.reject(errors[calls++] as Error)),
      () => clock.advance(10_000),
    );
    expect(result.error).toBe(errors[2]);
    expect(calls).toBe(3);
  });

  it("throws a permanent error at once, without waiting", async () => {
    const { retrier, clock } = make();
    const error = permanent();
    await expect(retrier.run(() => Promise.reject(error))).rejects.toBe(error);
    expect(clock.sleeps).toEqual([]);
  });

  it("stops waiting when aborted", async () => {
    const { retrier, clock } = make();
    const controller = new AbortController();
    const outcome = settled(
      retrier.run(() => Promise.reject(transient()), controller.signal),
      async () => {
        controller.abort(new Error("stop"));
        await clock.advance(10_000);
      },
    );
    expect((await outcome).error).toEqual(new Error("stop"));
  });

  it("does not start when already aborted", async () => {
    const { retrier } = make();
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    let calls = 0;
    await expect(
      retrier.run(() => {
        calls++;
        return Promise.resolve(1);
      }, controller.signal),
    ).rejects.toThrow("stop");
    expect(calls).toBe(0);
  });

  it("logs each retry with what failed and how long it waits", async () => {
    const lines: string[] = [];
    const logger = createJsonLogger({ write: (line) => lines.push(line), level: "warn" });
    const { retrier, clock } = make({ logger, label: "ollama:llama3.2" });
    let calls = 0;
    await settled(
      retrier.run(() => (calls++ < 1 ? Promise.reject(transient("boom")) : Promise.resolve(1))),
      () => clock.advance(1000),
    );
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({
      level: "warn",
      message: "retrying after a failure",
      target: "ollama:llama3.2",
      retry: 1,
      of: 4,
      waitMs: 100,
      error: "boom",
    });
  });
});

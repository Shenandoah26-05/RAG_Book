import { describe, expect, it } from "vitest";
import { FakeClock, settle } from "../../testing/fake-clock.testing.js";
import { RateLimiter } from "./rate-limiter.js";

/** Records the order in which turns are granted. */
function turns(limiter: RateLimiter, names: readonly string[]) {
  const granted: string[] = [];
  const releases = new Map<string, () => void>();
  for (const name of names) {
    void limiter.acquire().then((release) => {
      granted.push(name);
      releases.set(name, release);
    });
  }
  return { granted, releases };
}

describe("RateLimiter: rate", () => {
  it("lets N calls start in the window and holds the next until the oldest leaves it", async () => {
    const clock = new FakeClock();
    const limiter = new RateLimiter({ requestsPerMinute: 2, windowMs: 1000, clock });
    const { granted } = turns(limiter, ["a", "b", "c"]);
    await settle();
    expect(granted).toEqual(["a", "b"]);
    expect(limiter.waiting).toBe(1);

    await clock.advance(999);
    expect(granted).toEqual(["a", "b"]);
    await clock.advance(1);
    expect(granted).toEqual(["a", "b", "c"]);
  });

  it("counts a sliding window, so a burst across a boundary cannot double the rate", async () => {
    const clock = new FakeClock();
    const limiter = new RateLimiter({ requestsPerMinute: 2, windowMs: 1000, clock });
    const first = turns(limiter, ["a"]);
    await settle();
    await clock.advance(900);
    const rest = turns(limiter, ["b", "c"]);
    await settle();
    // a started at 0, b at 900: c must wait until a leaves the window at 1000, not until 1900
    expect(rest.granted).toEqual(["b"]);
    await clock.advance(100);
    expect(rest.granted).toEqual(["b", "c"]);
    expect(first.granted).toEqual(["a"]);
  });

  it("serves the waiting in the order they asked", async () => {
    const clock = new FakeClock();
    const limiter = new RateLimiter({ requestsPerMinute: 1, windowMs: 100, clock });
    const { granted } = turns(limiter, ["a", "b", "c", "d"]);
    await settle();
    await clock.advance(1000);
    expect(granted).toEqual(["a", "b", "c", "d"]);
  });

  it("does not count a turn that never started", async () => {
    const clock = new FakeClock();
    const limiter = new RateLimiter({ requestsPerMinute: 1, windowMs: 1000, clock });
    turns(limiter, ["a"]);
    const controller = new AbortController();
    const abandoned = limiter.acquire(controller.signal);
    abandoned.catch(() => undefined);
    await settle();
    controller.abort(new Error("changed my mind"));
    await expect(abandoned).rejects.toThrow("changed my mind");
    expect(limiter.waiting).toBe(0);
  });
});

describe("RateLimiter: concurrency", () => {
  it("lets M calls run at once and starts the next when one finishes", async () => {
    const limiter = new RateLimiter({ maxConcurrent: 2 });
    const { granted, releases } = turns(limiter, ["a", "b", "c"]);
    await settle();
    expect(granted).toEqual(["a", "b"]);

    releases.get("a")?.();
    await settle();
    expect(granted).toEqual(["a", "b", "c"]);
  });

  it("gives a turn back once, however often the release is called", async () => {
    const limiter = new RateLimiter({ maxConcurrent: 1 });
    const { granted, releases } = turns(limiter, ["a", "b", "c"]);
    await settle();
    releases.get("a")?.();
    releases.get("a")?.();
    releases.get("a")?.();
    await settle();
    expect(granted).toEqual(["a", "b"]);
  });

  it("applies both limits together", async () => {
    const clock = new FakeClock();
    const limiter = new RateLimiter({
      requestsPerMinute: 2,
      maxConcurrent: 1,
      windowMs: 1000,
      clock,
    });
    const { granted, releases } = turns(limiter, ["a", "b", "c"]);
    await settle();
    expect(granted).toEqual(["a"]);
    releases.get("a")?.();
    await settle();
    expect(granted).toEqual(["a", "b"]);
    releases.get("b")?.();
    await settle();
    // the rate limit holds c even though nothing is running
    expect(granted).toEqual(["a", "b"]);
    await clock.advance(1000);
    expect(granted).toEqual(["a", "b", "c"]);
  });

  it("removes an aborted waiter without disturbing the others", async () => {
    const limiter = new RateLimiter({ maxConcurrent: 1 });
    const { granted, releases } = turns(limiter, ["a"]);
    await settle();
    const controller = new AbortController();
    const dropped = limiter.acquire(controller.signal);
    dropped.catch(() => undefined);
    const later = turns(limiter, ["c"]);
    controller.abort(new Error("gone"));
    await expect(dropped).rejects.toThrow("gone");
    releases.get("a")?.();
    await settle();
    expect(granted).toEqual(["a"]);
    expect(later.granted).toEqual(["c"]);
  });

  it("rejects at once for a signal that is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("late"));
    await expect(new RateLimiter().acquire(controller.signal)).rejects.toThrow("late");
  });
});

describe("RateLimiter: housekeeping", () => {
  it("lets everything through when no limit is set", async () => {
    const { granted } = turns(new RateLimiter(), ["a", "b", "c", "d", "e"]);
    await settle();
    expect(granted).toHaveLength(5);
  });

  it("leaves no timer behind when the queue empties", async () => {
    const clock = new FakeClock();
    const limiter = new RateLimiter({ requestsPerMinute: 1, windowMs: 1000, clock });
    turns(limiter, ["a"]);
    const controller = new AbortController();
    const waiting = limiter.acquire(controller.signal);
    waiting.catch(() => undefined);
    await settle();
    expect(clock.pending).toBe(1);
    controller.abort(new Error("x"));
    await settle();
    expect(clock.pending).toBe(0);
  });

  it.each([
    [{ requestsPerMinute: -1 }, /requestsPerMinute/],
    [{ maxConcurrent: 1.5 }, /maxConcurrent/],
    [{ windowMs: 0 }, /windowMs/],
  ])("rejects bad limits %j", (options, message) => {
    expect(() => new RateLimiter(options)).toThrow(message);
  });
});

import { describe, expect, it } from "vitest";
import { FakeClock, settle } from "../../testing/fake-clock.testing.js";
import { RateLimitedEmbedder, RateLimitedProvider } from "./rate-limited.js";
import { RateLimiter } from "./rate-limiter.js";
import { end, read, scriptedEmbedder, scriptedProvider, text } from "./resilience.testing.js";

const messages = [{ role: "user", content: "hi" }] as const;

describe("RateLimitedProvider", () => {
  it("passes a reply through", async () => {
    const provider = new RateLimitedProvider(
      scriptedProvider([{ events: [text("a"), end] }]),
      new RateLimiter({ maxConcurrent: 1 }),
    );
    expect(await read(provider.chat(messages))).toEqual(["a"]);
    expect(provider.modelId).toBe("fake:model");
  });

  it("keeps a second answer waiting until the first has been read to the end", async () => {
    const limiter = new RateLimiter({ maxConcurrent: 1 });
    const inner = scriptedProvider([{ events: [text("a"), text("b"), end] }]);
    const provider = new RateLimitedProvider(inner, limiter);

    const first = provider.chat(messages)[Symbol.asyncIterator]();
    await first.next(); // the first answer is under way and holds the only turn
    let secondRead = false;
    const second = read(provider.chat(messages)).then(() => {
      secondRead = true;
    });
    await settle();
    expect(secondRead).toBe(false);
    expect(inner.calls).toHaveLength(1);

    while ((await first.next()).done !== true) {
      // drain the rest of the first answer
    }
    await second;
    expect(secondRead).toBe(true);
    expect(inner.calls).toHaveLength(2);
  });

  it("gives the turn back when the caller stops early", async () => {
    const limiter = new RateLimiter({ maxConcurrent: 1 });
    const provider = new RateLimitedProvider(
      scriptedProvider([{ events: [text("a"), text("b"), end] }]),
      limiter,
    );
    for await (const delta of provider.chat(messages)) {
      if (delta.kind === "text") break;
    }
    // would wait for ever if the turn were still held
    expect(await read(provider.chat(messages))).toEqual(["a", "b"]);
  });

  it("gives the turn back when the reply fails", async () => {
    const limiter = new RateLimiter({ maxConcurrent: 1 });
    const provider = new RateLimitedProvider(
      scriptedProvider([{ fail: new Error("boom") }, { events: [text("ok"), end] }]),
      limiter,
    );
    await expect(read(provider.chat(messages))).rejects.toThrow("boom");
    expect(await read(provider.chat(messages))).toEqual(["ok"]);
  });

  it("spaces calls by the rate limit", async () => {
    const clock = new FakeClock();
    const inner = scriptedProvider([{ events: [text("a"), end] }]);
    const provider = new RateLimitedProvider(
      inner,
      new RateLimiter({ requestsPerMinute: 1, windowMs: 1000, clock }),
    );
    await read(provider.chat(messages));
    let done = false;
    const second = read(provider.chat(messages)).then(() => {
      done = true;
    });
    await settle();
    expect(done).toBe(false);
    await clock.advance(1000);
    await second;
    expect(inner.calls).toHaveLength(2);
  });

  it("stops waiting for a turn when the caller aborts", async () => {
    const limiter = new RateLimiter({ maxConcurrent: 1 });
    const provider = new RateLimitedProvider(
      scriptedProvider([{ events: [text("a"), text("b"), end] }]),
      limiter,
    );
    const first = provider.chat(messages)[Symbol.asyncIterator]();
    await first.next();
    const caller = new AbortController();
    const waiting = read(provider.chat(messages, { signal: caller.signal }));
    waiting.catch(() => undefined);
    await settle();
    caller.abort(new Error("enough"));
    await expect(waiting).rejects.toThrow("enough");
    expect(limiter.waiting).toBe(0);
    await first.return?.();
  });

  it("shares one limit between wrappers of the same limiter", async () => {
    const limiter = new RateLimiter({ maxConcurrent: 1 });
    const a = new RateLimitedProvider(scriptedProvider([{ events: [text("a"), end] }]), limiter);
    const b = new RateLimitedProvider(scriptedProvider([{ events: [text("b"), end] }]), limiter);
    const holding = a.chat(messages)[Symbol.asyncIterator]();
    await holding.next();
    let bDone = false;
    const waiting = read(b.chat(messages)).then(() => {
      bDone = true;
    });
    await settle();
    expect(bDone).toBe(false);
    await holding.return?.();
    await waiting;
    expect(bDone).toBe(true);
  });
});

describe("RateLimitedEmbedder", () => {
  it("holds the turn for the whole call", async () => {
    const limiter = new RateLimiter({ maxConcurrent: 1 });
    const embedder = new RateLimitedEmbedder(scriptedEmbedder(["hang", "ok"]), limiter);
    void embedder.embed(["a"], "document");
    await settle();
    const waiting = embedder.embed(["b"], "document");
    waiting.catch(() => undefined);
    await settle();
    expect(limiter.waiting).toBe(1);
  });

  it("gives the turn back after a failure", async () => {
    const limiter = new RateLimiter({ maxConcurrent: 1 });
    const embedder = new RateLimitedEmbedder(scriptedEmbedder([new Error("boom"), "ok"]), limiter);
    await expect(embedder.embed(["a"], "query")).rejects.toThrow("boom");
    expect(await embedder.embed(["a"], "query")).toHaveLength(1);
  });

  it("is the same embedder to everyone else", () => {
    const embedder = new RateLimitedEmbedder(scriptedEmbedder(["ok"]), new RateLimiter());
    expect([embedder.modelId, embedder.dimensions]).toEqual(["fake:embed", 2]);
  });
});

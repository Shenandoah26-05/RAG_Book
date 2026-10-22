import { describe, expect, it } from "vitest";
import type { ChatDelta, LlmProvider } from "../../core/index.js";
import { RagError } from "../../shared/index.js";
import { FakeClock, settle } from "../../testing/fake-clock.testing.js";
import { isRetryable } from "./retrier.js";
import {
  end,
  read,
  scriptedEmbedder,
  scriptedProvider,
  settled,
  text,
} from "./resilience.testing.js";
import { TimeoutEmbedder, TimeoutProvider } from "./timeout.js";

const messages = [{ role: "user", content: "hi" }] as const;

describe("TimeoutProvider", () => {
  it("passes a prompt reply through and leaves no timer running", async () => {
    const clock = new FakeClock();
    const inner = scriptedProvider([{ events: [text("a"), text("b"), end] }]);
    const provider = new TimeoutProvider(inner, { timeoutMs: 1000, clock });
    expect(await read(provider.chat(messages))).toEqual(["a", "b"]);
    expect(clock.pending).toBe(0);
    expect(provider.modelId).toBe("fake:model");
  });

  it("gives up on a model that never starts, with an error that can be retried", async () => {
    const clock = new FakeClock();
    const inner = scriptedProvider([{ hang: true }]);
    const provider = new TimeoutProvider(inner, { timeoutMs: 1000, clock });
    const outcome = await settled(read(provider.chat(messages)), () => clock.advance(1000));
    expect(outcome.error).toBeInstanceOf(RagError);
    expect((outcome.error as RagError).code).toBe("PROVIDER_UNAVAILABLE");
    expect((outcome.error as RagError).message).toBe("fake:model sent nothing for 1000 ms");
    expect(isRetryable(outcome.error)).toBe(true);
    expect(clock.pending).toBe(0);
  });

  it("counts silence, not length: a long answer that keeps arriving is never cut", async () => {
    const clock = new FakeClock();
    const inner = scriptedProvider(
      [{ events: [text("1"), text("2"), text("3"), text("4"), text("5"), end], gapMs: 400 }],
      (ms) => clock.sleep(ms),
    );
    const provider = new TimeoutProvider(inner, { timeoutMs: 500, clock });
    const outcome = await settled(read(provider.chat(messages)), () => clock.advance(5000));
    // five gaps of 400 ms is 2,000 ms in all, four times the limit
    expect(outcome.value).toEqual(["1", "2", "3", "4", "5"]);
  });

  it("abandons a reply that stops half-way, and keeps what was already passed on", async () => {
    const clock = new FakeClock();
    const stalls: LlmProvider = {
      modelId: "fake:model",
      chat: () =>
        (async function* (): AsyncGenerator<ChatDelta> {
          yield text("The ans");
          await new Promise<never>(() => undefined);
        })(),
    };
    const seen: string[] = [];
    const outcome = await settled(
      (async () => {
        for await (const delta of new TimeoutProvider(stalls, { timeoutMs: 1000, clock }).chat(
          messages,
        )) {
          if (delta.kind === "text") seen.push(delta.text);
        }
      })(),
      () => clock.advance(1000),
    );
    expect(seen).toEqual(["The ans"]);
    expect((outcome.error as RagError).message).toContain("sent nothing for 1000 ms");
  });

  it("aborts the request underneath, so the adapter can close its connection", async () => {
    const clock = new FakeClock();
    let seen: AbortSignal | undefined;
    const inner: LlmProvider = {
      modelId: "fake:model",
      chat: (_messages, options) => {
        seen = options?.signal;
        return (async function* (): AsyncGenerator<ChatDelta> {
          await new Promise<never>(() => undefined);
          yield end;
        })();
      },
    };
    const provider = new TimeoutProvider(inner, { timeoutMs: 1000, clock });
    await settled(read(provider.chat(messages)), () => clock.advance(1000));
    expect(seen?.aborted).toBe(true);
    expect((seen?.reason as RagError).message).toContain("sent nothing");
  });

  it("is not held by a provider that ignores the signal", async () => {
    const clock = new FakeClock();
    const inner = scriptedProvider([{ hang: true }]);
    const outcome = await settled(
      read(new TimeoutProvider(inner, { timeoutMs: 50, clock }).chat(messages)),
      () => clock.advance(50),
    );
    expect(outcome.error).toBeInstanceOf(RagError);
  });

  it("passes the caller's own abort down, and reports it as theirs", async () => {
    const clock = new FakeClock();
    const caller = new AbortController();
    let seen: AbortSignal | undefined;
    const inner: LlmProvider = {
      modelId: "fake:model",
      chat: (_m, options) => {
        seen = options?.signal;
        return (async function* (): AsyncGenerator<ChatDelta> {
          await new Promise<void>((_, reject) => {
            seen?.addEventListener("abort", () => {
              reject(seen?.reason as Error);
            });
          });
          yield end;
        })();
      },
    };
    const provider = new TimeoutProvider(inner, { timeoutMs: 10_000, clock });
    const outcome = await settled(
      read(provider.chat(messages, { signal: caller.signal })),
      async () => {
        caller.abort(new Error("user pressed Ctrl+C"));
        await settle();
      },
    );
    expect(outcome.error).toEqual(new Error("user pressed Ctrl+C"));
    expect(isRetryable(outcome.error)).toBe(false);
  });

  it("does not start for a signal that is already aborted", async () => {
    const caller = new AbortController();
    caller.abort(new Error("no"));
    const inner = scriptedProvider([{ events: [end] }]);
    await expect(
      read(
        new TimeoutProvider(inner, { timeoutMs: 10, clock: new FakeClock() }).chat(messages, {
          signal: caller.signal,
        }),
      ),
    ).rejects.toThrow("no");
    expect(inner.calls).toHaveLength(0);
  });

  it("passes the other options through", async () => {
    const clock = new FakeClock();
    const inner = scriptedProvider([{ events: [end] }]);
    await read(
      new TimeoutProvider(inner, { timeoutMs: 10, clock }).chat(messages, { temperature: 0.4 }),
    );
    expect(inner.calls[0]?.options).toMatchObject({ temperature: 0.4 });
  });

  it("closes the reply underneath when the caller stops reading early", async () => {
    const clock = new FakeClock();
    const inner = scriptedProvider([{ events: [text("a"), text("b"), end] }]);
    for await (const delta of new TimeoutProvider(inner, { timeoutMs: 10, clock }).chat(messages)) {
      if (delta.kind === "text") break;
    }
    expect(inner.closed()).toBe(1);
    expect(clock.pending).toBe(0);
  });

  it.each([0, -5, 1.5, Number.NaN])("rejects the timeout %s", (timeoutMs) => {
    expect(() => new TimeoutProvider(scriptedProvider([]), { timeoutMs })).toThrow(/timeoutMs/);
  });
});

describe("TimeoutEmbedder", () => {
  it("returns the vectors of a call that is in time", async () => {
    const clock = new FakeClock();
    const embedder = new TimeoutEmbedder(scriptedEmbedder(["ok"]), { timeoutMs: 1000, clock });
    expect(await embedder.embed(["a", "b"], "document")).toHaveLength(2);
    expect(clock.pending).toBe(0);
    expect([embedder.modelId, embedder.dimensions]).toEqual(["fake:embed", 2]);
  });

  it("frees the caller with a retryable error when the call takes too long", async () => {
    const clock = new FakeClock();
    const embedder = new TimeoutEmbedder(scriptedEmbedder(["hang"]), { timeoutMs: 1000, clock });
    const outcome = await settled(embedder.embed(["a"], "query"), () => clock.advance(1000));
    expect((outcome.error as RagError).message).toBe("fake:embed did not answer within 1000 ms");
    expect(isRetryable(outcome.error)).toBe(true);
  });

  it("passes a failure through as it is", async () => {
    const error = new RagError("PROVIDER_UNAVAILABLE", "nope", { retryable: false });
    const embedder = new TimeoutEmbedder(scriptedEmbedder([error]), {
      timeoutMs: 1000,
      clock: new FakeClock(),
    });
    await expect(embedder.embed(["a"], "query")).rejects.toBe(error);
  });

  it("does not turn the late failure of an abandoned call into an unhandled rejection", async () => {
    const clock = new FakeClock();
    let fail: (error: Error) => void = () => undefined;
    const slow = {
      modelId: "fake:embed",
      dimensions: 2,
      embed: () =>
        new Promise<never>((_, reject) => {
          fail = reject;
        }),
    };
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      await settled(new TimeoutEmbedder(slow, { timeoutMs: 10, clock }).embed(["a"], "query"), () =>
        clock.advance(10),
      );
      fail(new Error("too late"));
      await new Promise((resolve) => setTimeout(resolve, 5));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });

  it("rejects a timeout that is not a whole number of 1 or more", () => {
    expect(() => new TimeoutEmbedder(scriptedEmbedder([]), { timeoutMs: 0 })).toThrow(/timeoutMs/);
  });
});

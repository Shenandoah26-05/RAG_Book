import { describe, expect, it } from "vitest";
import { FakeClock } from "../../testing/fake-clock.testing.js";
import { Retrier } from "./retrier.js";
import { RetryingEmbedder, RetryingProvider } from "./retrying.js";
import {
  end,
  permanent,
  read,
  scriptedEmbedder,
  scriptedProvider,
  settled,
  text,
  transient,
} from "./resilience.testing.js";

const setup = (retries = 3) => {
  const clock = new FakeClock();
  const retrier = new Retrier({
    retries,
    baseDelayMs: 100,
    maxDelayMs: 1000,
    clock,
    random: () => 1,
  });
  return { clock, retrier };
};
const messages = [{ role: "user", content: "hi" }] as const;

describe("RetryingProvider", () => {
  it("passes a good reply through untouched, with one call", async () => {
    const { retrier } = setup();
    const inner = scriptedProvider([{ events: [text("a"), text("b"), end] }]);
    const provider = new RetryingProvider(inner, retrier);
    expect(await read(provider.chat(messages))).toEqual(["a", "b"]);
    expect(inner.calls).toHaveLength(1);
    expect(provider.modelId).toBe("fake:model");
  });

  it("tries again when the call fails before anything was passed on", async () => {
    const { retrier, clock } = setup();
    const inner = scriptedProvider([
      { fail: transient("down") },
      { fail: transient("still down") },
      { events: [text("hello"), end] },
    ]);
    const outcome = await settled(read(new RetryingProvider(inner, retrier).chat(messages)), () =>
      clock.advance(5000),
    );
    expect(outcome.value).toEqual(["hello"]);
    expect(inner.calls).toHaveLength(3);
    expect(clock.sleeps).toEqual([100, 200]);
  });

  it("sends the same messages and options on every attempt", async () => {
    const { retrier, clock } = setup();
    const inner = scriptedProvider([{ fail: transient() }, { events: [text("x"), end] }]);
    const options = { temperature: 0.3, maxOutputTokens: 50 };
    await settled(read(new RetryingProvider(inner, retrier).chat(messages, options)), () =>
      clock.advance(5000),
    );
    expect(inner.calls.map((c) => [c.messages, c.options])).toEqual([
      [messages, options],
      [messages, options],
    ]);
  });

  it("does not retry once text has reached the caller: the reader would see it twice", async () => {
    const { retrier } = setup();
    const failure = transient("dropped mid-answer");
    const inner = scriptedProvider([
      { events: [text("The ans")], fail: failure },
      { events: [text("x"), end] },
    ]);
    const seen: string[] = [];
    const provider = new RetryingProvider(inner, retrier);
    await expect(
      (async () => {
        for await (const delta of provider.chat(messages)) {
          if (delta.kind === "text") seen.push(delta.text);
        }
      })(),
    ).rejects.toBe(failure);
    expect(seen).toEqual(["The ans"]);
    expect(inner.calls).toHaveLength(1);
  });

  it("throws a permanent error at once", async () => {
    const { retrier, clock } = setup();
    const error = permanent();
    const inner = scriptedProvider([{ fail: error }]);
    await expect(read(new RetryingProvider(inner, retrier).chat(messages))).rejects.toBe(error);
    expect(inner.calls).toHaveLength(1);
    expect(clock.sleeps).toEqual([]);
  });

  it("throws the last error when the retries run out", async () => {
    const { retrier, clock } = setup(2);
    const errors = [transient("1"), transient("2"), transient("3")];
    const inner = scriptedProvider(errors.map((fail) => ({ fail })));
    const outcome = await settled(read(new RetryingProvider(inner, retrier).chat(messages)), () =>
      clock.advance(5000),
    );
    expect(outcome.error).toBe(errors[2]);
    expect(inner.calls).toHaveLength(3);
  });

  it("stops retrying when the caller aborts while it waits", async () => {
    const { retrier, clock } = setup();
    const inner = scriptedProvider([{ fail: transient() }]);
    const controller = new AbortController();
    const outcome = await settled(
      read(new RetryingProvider(inner, retrier).chat(messages, { signal: controller.signal })),
      async () => {
        controller.abort(new Error("enough"));
        await clock.advance(5000);
      },
    );
    expect(outcome.error).toEqual(new Error("enough"));
    expect(inner.calls).toHaveLength(1);
  });

  it("closes the reply underneath when the caller stops reading early", async () => {
    const { retrier } = setup();
    const inner = scriptedProvider([{ events: [text("a"), text("b"), text("c"), end] }]);
    for await (const delta of new RetryingProvider(inner, retrier).chat(messages)) {
      if (delta.kind === "text") break;
    }
    expect(inner.closed()).toBe(1);
  });

  it("reads the model lazily, like the port says", () => {
    const { retrier } = setup();
    const inner = scriptedProvider([{ events: [end] }]);
    new RetryingProvider(inner, retrier).chat(messages);
    expect(inner.calls).toHaveLength(0);
  });
});

describe("RetryingEmbedder", () => {
  it("tries again and returns the vectors of the attempt that worked", async () => {
    const { retrier, clock } = setup();
    const inner = scriptedEmbedder([transient(), transient(), "ok"]);
    const embedder = new RetryingEmbedder(inner, retrier);
    const outcome = await settled(embedder.embed(["a", "b"], "document"), () =>
      clock.advance(5000),
    );
    expect(outcome.value).toHaveLength(2);
    expect(inner.calls).toEqual([
      { texts: ["a", "b"], kind: "document" },
      { texts: ["a", "b"], kind: "document" },
      { texts: ["a", "b"], kind: "document" },
    ]);
  });

  it("does not retry a permanent failure", async () => {
    const { retrier } = setup();
    const error = permanent();
    const inner = scriptedEmbedder([error]);
    await expect(new RetryingEmbedder(inner, retrier).embed(["a"], "query")).rejects.toBe(error);
    expect(inner.calls).toHaveLength(1);
  });

  it("is the same embedder to everyone else", () => {
    const { retrier } = setup();
    const embedder = new RetryingEmbedder(scriptedEmbedder(["ok"]), retrier);
    expect([embedder.modelId, embedder.dimensions]).toEqual(["fake:embed", 2]);
  });
});

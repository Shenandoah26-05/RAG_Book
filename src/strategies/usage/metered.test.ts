import { describe, expect, it } from "vitest";
import type { ChatDelta, Embedder, LlmProvider } from "../../core/index.js";
import { RagError, Trace, usageOf, withTrace } from "../../shared/index.js";
import { FakeClock } from "../../testing/fake-clock.testing.js";
import { MeteredEmbedder, MeteredProvider } from "./metered.js";

const messages = [{ role: "user", content: "hi" }] as const;

/** A model that plays `events`, taking `gapMs` of fake time before each. */
function model(
  events: readonly ChatDelta[],
  options: { clock?: FakeClock; gapMs?: number; fail?: Error } = {},
): LlmProvider {
  return {
    modelId: "ollama:llama3.2",
    chat: () =>
      (async function* (): AsyncGenerator<ChatDelta> {
        for (const event of events) {
          if (options.clock !== undefined && options.gapMs !== undefined) {
            options.clock.sleep(options.gapMs).catch(() => undefined);
            await options.clock.advance(options.gapMs);
          }
          yield event;
        }
        if (options.fail !== undefined) throw options.fail;
      })(),
  };
}

const reply = (...texts: string[]): ChatDelta[] => [
  ...texts.map((text): ChatDelta => ({ kind: "text", text })),
  { kind: "end", reason: "stop", promptTokens: 1200, outputTokens: 80 },
];
const read = async (stream: AsyncIterable<ChatDelta>): Promise<string> => {
  let text = "";
  for await (const delta of stream) if (delta.kind === "text") text += delta.text;
  return text;
};
const callsOn = (trace: Trace) => usageOf(trace.snapshot().stages);

describe("MeteredProvider", () => {
  it("records the model, the tokens it reported and whether the call finished", async () => {
    const trace = new Trace();
    const metered = new MeteredProvider(model(reply("Hel", "lo")));
    expect(await withTrace(trace, () => read(metered.chat(messages)))).toBe("Hello");

    const [stage] = trace.snapshot().stages;
    expect(stage).toMatchObject({
      stage: "model-call",
      status: "ok",
      summary: {
        model: "ollama:llama3.2",
        promptTokens: 1200,
        outputTokens: 80,
        characters: 5,
        completed: true,
      },
    });
    expect(callsOn(trace)).toHaveLength(1);
  });

  it("times the first piece of the reply with its clock", async () => {
    const clock = new FakeClock();
    const trace = new Trace();
    const metered = new MeteredProvider(model(reply("a", "b"), { clock, gapMs: 250 }), { clock });
    await withTrace(trace, () => read(metered.chat(messages)));
    expect(trace.snapshot().stages[0]?.summary["firstTokenMs"]).toBe(250);
  });

  it("is recorded on the trace of the call, even when the reply is read outside the scope", async () => {
    // the reply is a lazily-run stream, so the trace has to be found when chat() is called
    const trace = new Trace();
    const metered = new MeteredProvider(model(reply("x")));
    const stream = withTrace(trace, () => metered.chat(messages));
    await read(stream); // read here, where no trace is in scope
    expect(callsOn(trace)).toHaveLength(1);
  });

  it("keeps the calls of concurrent questions apart", async () => {
    const first = new Trace();
    const second = new Trace();
    const metered = new MeteredProvider(model(reply("x")));
    await Promise.all([
      withTrace(first, () => read(metered.chat(messages))),
      withTrace(second, () => read(metered.chat(messages))),
      withTrace(second, () => read(metered.chat(messages))),
    ]);
    expect([callsOn(first).length, callsOn(second).length]).toEqual([1, 2]);
  });

  it("does nothing outside a question, and hands back the model's own stream", async () => {
    const inner = model(reply("plain"));
    const metered = new MeteredProvider(inner);
    expect(await read(metered.chat(messages))).toBe("plain");
  });

  it("records a call that failed, with the model, and rethrows the error as it is", async () => {
    const trace = new Trace();
    const failure = new RagError("PROVIDER_UNAVAILABLE", "down");
    const metered = new MeteredProvider(model([], { fail: failure }));
    await expect(withTrace(trace, () => read(metered.chat(messages)))).rejects.toBe(failure);
    expect(trace.snapshot().stages[0]).toMatchObject({
      stage: "model-call",
      status: "error",
      error: "down",
      summary: { model: "ollama:llama3.2" },
    });
    expect(callsOn(trace)[0]?.ok).toBe(false);
  });

  it("records a reply that was stopped early as not completed, with what it cost so far", async () => {
    const trace = new Trace();
    const metered = new MeteredProvider(model(reply("one", "two", "three")));
    await withTrace(trace, async () => {
      for await (const delta of metered.chat(messages)) {
        if (delta.kind === "text") break;
      }
    });
    expect(trace.snapshot().stages[0]?.summary).toMatchObject({
      completed: false,
      characters: 3,
      promptTokens: null,
    });
  });

  it("leaves tokens null when the model did not report them", async () => {
    const trace = new Trace();
    const metered = new MeteredProvider(
      model([
        { kind: "text", text: "hi" },
        { kind: "end", reason: "stop" },
      ]),
    );
    await withTrace(trace, () => read(metered.chat(messages)));
    expect(trace.snapshot().stages[0]?.summary).toMatchObject({
      promptTokens: null,
      outputTokens: null,
    });
  });

  it("passes the messages and options through, and is the same model to everyone", async () => {
    let seen: unknown;
    const inner: LlmProvider = {
      modelId: "x:y",
      chat: (m, o) => {
        seen = [m, o];
        return model(reply("a")).chat(m, o);
      },
    };
    const metered = new MeteredProvider(inner);
    await withTrace(new Trace(), () => read(metered.chat(messages, { temperature: 0.4 })));
    expect(seen).toEqual([messages, { temperature: 0.4 }]);
    expect(metered.modelId).toBe("x:y");
  });
});

describe("MeteredEmbedder", () => {
  const embedder = (fail?: Error): Embedder => ({
    modelId: "openai-compatible:text-embedding-3-small",
    dimensions: 2,
    embed: (texts) =>
      fail === undefined
        ? Promise.resolve(texts.map(() => Float32Array.of(1, 0)))
        : Promise.reject(fail),
  });

  it("records the call with an estimate of the tokens sent, marked as an estimate", async () => {
    const trace = new Trace();
    const metered = new MeteredEmbedder(embedder());
    const vectors = await withTrace(trace, () => metered.embed(["abcd", "efghij"], "document"));
    expect(vectors).toHaveLength(2);
    // 10 characters at 4 per token, rounded up
    expect(trace.snapshot().stages[0]).toMatchObject({
      stage: "embed-call",
      summary: {
        model: "openai-compatible:text-embedding-3-small",
        texts: 2,
        kind: "document",
        promptTokens: 3,
        estimated: true,
      },
    });
  });

  it("records a failed call and rethrows it", async () => {
    const trace = new Trace();
    const failure = new RagError("PROVIDER_UNAVAILABLE", "down");
    await expect(
      withTrace(trace, () => new MeteredEmbedder(embedder(failure)).embed(["a"], "query")),
    ).rejects.toBe(failure);
    expect(trace.snapshot().stages[0]).toMatchObject({ status: "error", summary: { texts: 1 } });
  });

  it("records nothing outside a question or for no texts", async () => {
    const metered = new MeteredEmbedder(embedder());
    expect(await metered.embed(["a"], "query")).toHaveLength(1);
    const trace = new Trace();
    await withTrace(trace, () => metered.embed([], "query"));
    expect(trace.stages).toEqual([]);
  });

  it("is the same embedder to everyone else", () => {
    const metered = new MeteredEmbedder(embedder());
    expect([metered.modelId, metered.dimensions]).toEqual([
      "openai-compatible:text-embedding-3-small",
      2,
    ]);
  });
});

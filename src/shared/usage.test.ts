import { describe, expect, it } from "vitest";
import { currentTrace, withTrace } from "./trace-scope.js";
import { Trace } from "./trace.js";
import type { StageRecord } from "./trace.js";
import { costOf, EMBED_CALL_STAGE, MODEL_CALL_STAGE, totalUsage, usageOf } from "./usage.js";
import type { PriceTable, UsageEntry } from "./usage.js";

const stage = (name: string, summary: StageRecord["summary"], status: "ok" | "error" = "ok") =>
  ({ stage: name, startMs: 0, durationMs: 100, status, summary }) satisfies StageRecord;

const call = (
  model: string,
  promptTokens: number | null,
  outputTokens: number | null,
  extra: StageRecord["summary"] = {},
) =>
  stage(MODEL_CALL_STAGE, {
    model,
    promptTokens,
    outputTokens,
    firstTokenMs: 30,
    completed: true,
    ...extra,
  });

describe("usageOf", () => {
  it("reads the metered calls and nothing else", () => {
    const entries = usageOf([
      stage("retrieve", { found: 5 }),
      call("ollama:llama3.2", 1200, 80),
      stage("generate", { model: "ollama:llama3.2", promptTokens: 1200, outputTokens: 80 }),
      stage(EMBED_CALL_STAGE, { model: "ollama:all-minilm", promptTokens: 12, estimated: true }),
    ]);
    expect(entries).toEqual([
      {
        kind: "model",
        modelId: "ollama:llama3.2",
        promptTokens: 1200,
        outputTokens: 80,
        estimated: false,
        latencyMs: 100,
        firstTokenMs: 30,
        ok: true,
      },
      {
        kind: "embed",
        modelId: "ollama:all-minilm",
        promptTokens: 12,
        outputTokens: undefined,
        estimated: true,
        latencyMs: 100,
        firstTokenMs: undefined,
        ok: true,
      },
    ]);
  });

  it("does not count the pipeline's generate stage, which the metered call already covers", () => {
    expect(usageOf([stage("generate", { promptTokens: 5, outputTokens: 5 })])).toEqual([]);
  });

  it("treats unreported tokens as absent, not as zero", () => {
    const [entry] = usageOf([call("m", null, null, { firstTokenMs: null })]);
    expect(entry).toMatchObject({
      promptTokens: undefined,
      outputTokens: undefined,
      firstTokenMs: undefined,
    });
  });

  it("marks a failed call and a reply that did not finish as not ok", () => {
    const entries = usageOf([
      stage(MODEL_CALL_STAGE, { model: "m" }, "error"),
      call("m", 10, 2, { completed: false }),
    ]);
    expect(entries.map((e) => e.ok)).toEqual([false, false]);
  });

  it("names a call with no model 'unknown'", () => {
    expect(usageOf([stage(MODEL_CALL_STAGE, {})])[0]?.modelId).toBe("unknown");
  });

  it("reads a real trace, including a stage that failed with a summary", () => {
    const trace = new Trace();
    trace
      .start(MODEL_CALL_STAGE)
      .end({ model: "a", promptTokens: 3, outputTokens: 1, completed: true });
    trace.start(MODEL_CALL_STAGE).fail(new Error("down"), { model: "b" });
    expect(usageOf(trace.snapshot().stages).map((e) => [e.modelId, e.ok])).toEqual([
      ["a", true],
      ["b", false],
    ]);
  });
});

const entry = (overrides: Partial<UsageEntry> = {}): UsageEntry => ({
  kind: "model",
  modelId: "m",
  promptTokens: 0,
  outputTokens: 0,
  estimated: false,
  latencyMs: 0,
  firstTokenMs: undefined,
  ok: true,
  ...overrides,
});

describe("totalUsage", () => {
  it("adds tokens and time, and keeps embedded tokens apart", () => {
    const totals = totalUsage([
      entry({ promptTokens: 1000, outputTokens: 100, latencyMs: 2000 }),
      entry({ promptTokens: 500, outputTokens: 50, latencyMs: 700 }),
      entry({ kind: "embed", promptTokens: 40, outputTokens: undefined, latencyMs: 30 }),
    ]);
    expect(totals).toEqual({
      calls: 3,
      failedCalls: 0,
      promptTokens: 1500,
      outputTokens: 150,
      embeddedTokens: 40,
      callsWithoutTokens: 0,
      modelMs: 2730,
    });
  });

  it("counts failed calls and calls whose provider reported no tokens", () => {
    const totals = totalUsage([
      entry({ promptTokens: undefined, outputTokens: undefined }),
      entry({ ok: false, promptTokens: 10, outputTokens: 0 }),
    ]);
    expect(totals).toMatchObject({
      calls: 2,
      failedCalls: 1,
      callsWithoutTokens: 1,
      promptTokens: 10,
    });
  });

  it("is all zeros for no calls", () => {
    expect(totalUsage([])).toEqual({
      calls: 0,
      failedCalls: 0,
      promptTokens: 0,
      outputTokens: 0,
      embeddedTokens: 0,
      callsWithoutTokens: 0,
      modelMs: 0,
    });
  });
});

describe("costOf", () => {
  const prices: PriceTable = {
    currency: "USD",
    models: {
      "openai-compatible:cheap": { inputPerMillion: 0.15, outputPerMillion: 0.6 },
      "openai-compatible:embed": { inputPerMillion: 0.02, outputPerMillion: 0 },
      "ollama:free": { inputPerMillion: 0, outputPerMillion: 0 },
    },
  };

  it("prices input and output separately, per million tokens: hand-computed", () => {
    // 1,000 in at 0.15/M and 500 out at 0.60/M: 0.00015 + 0.00030
    const cost = costOf(
      [entry({ modelId: "openai-compatible:cheap", promptTokens: 1000, outputTokens: 500 })],
      prices,
    );
    expect(cost.amount).toBeCloseTo(0.00045, 12);
    expect(cost).toMatchObject({ currency: "USD", unpricedTokens: 0 });
  });

  it("adds up many calls, to different models", () => {
    const cost = costOf(
      [
        entry({ modelId: "openai-compatible:cheap", promptTokens: 2_000_000, outputTokens: 0 }),
        entry({ modelId: "openai-compatible:cheap", promptTokens: 0, outputTokens: 1_000_000 }),
        entry({ modelId: "ollama:free", promptTokens: 9999, outputTokens: 9999 }),
      ],
      prices,
    );
    expect(cost.amount).toBeCloseTo(0.3 + 0.6, 12);
    expect(cost.unpricedTokens).toBe(0);
  });

  it("prices an embedding at the model's input price", () => {
    const cost = costOf(
      [
        entry({
          kind: "embed",
          modelId: "openai-compatible:embed",
          promptTokens: 5_000_000,
          outputTokens: undefined,
        }),
      ],
      prices,
    );
    expect(cost.amount).toBeCloseTo(0.1, 12);
  });

  it("separates a model that is free from one that has no price", () => {
    const cost = costOf(
      [
        entry({ modelId: "ollama:free", promptTokens: 100, outputTokens: 10 }),
        entry({ modelId: "openai-compatible:forgotten", promptTokens: 700, outputTokens: 30 }),
      ],
      prices,
    );
    expect(cost.amount).toBe(0);
    expect(cost.unpricedTokens).toBe(730);
  });

  it("does not take a price from the prototype", () => {
    const cost = costOf([entry({ modelId: "toString", promptTokens: 5, outputTokens: 5 })], prices);
    expect(cost).toMatchObject({ amount: 0, unpricedTokens: 10 });
  });

  it("is zero for no calls and for an empty table", () => {
    expect(costOf([], prices).amount).toBe(0);
    expect(
      costOf([entry({ promptTokens: 5, outputTokens: 5 })], { currency: "EUR", models: {} }),
    ).toEqual({ currency: "EUR", amount: 0, unpricedTokens: 10 });
  });
});

describe("withTrace and currentTrace", () => {
  it("has no trace outside a scope, and the trace inside it", () => {
    const trace = new Trace();
    expect(currentTrace()).toBeUndefined();
    expect(withTrace(trace, () => currentTrace())).toBe(trace);
    expect(currentTrace()).toBeUndefined();
  });

  it("follows asynchronous calls, including concurrent ones, each with its own trace", async () => {
    const a = new Trace();
    const b = new Trace();
    const seen = await Promise.all([
      withTrace(a, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return currentTrace();
      }),
      withTrace(b, async () => {
        await Promise.resolve();
        return currentTrace();
      }),
    ]);
    expect(seen).toEqual([a, b]);
  });

  it("does not follow a generator that is read outside the scope", async () => {
    const trace = new Trace();
    async function* lazy(): AsyncGenerator<Trace | undefined> {
      await Promise.resolve();
      yield currentTrace();
    }
    // created inside the scope, but its body runs where it is read
    const stream = withTrace(trace, () => lazy());
    const seen: (Trace | undefined)[] = [];
    for await (const value of stream) seen.push(value);
    expect(seen).toEqual([undefined]);
  });
});

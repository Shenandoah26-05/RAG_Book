import { describe, expect, it } from "vitest";
import type { AnswerJudge, LlmProvider, QuestionResult } from "../../core/index.js";
import { Trace, usageOf, withTrace } from "../../shared/index.js";
import type { PriceTable, UsageEntry } from "../../shared/index.js";
import { MeteredProvider } from "../../strategies/index.js";
import {
  chunkAt,
  factoryOf,
  fakeSystem,
  goldFor,
  judgement,
  memoryStore,
  question,
  ranked,
  variant,
} from "./experiment.testing.js";
import { resultUsage } from "./result-usage.js";
import { runExperiment } from "./run-experiment.js";
import type { RunExperimentDeps } from "./run-experiment.js";
import { summarizeVariant } from "./summarize.js";
import type { VariantFacts } from "./summarize.js";

const drain = async (stream: AsyncIterable<unknown>): Promise<void> => {
  const seen: unknown[] = [];
  for await (const event of stream) seen.push(event);
};

const PRICES: PriceTable = {
  currency: "USD",
  models: { "openai-compatible:cheap": { inputPerMillion: 1, outputPerMillion: 2 } },
};
const call = (overrides: Partial<UsageEntry> = {}): UsageEntry => ({
  kind: "model",
  modelId: "openai-compatible:cheap",
  promptTokens: 1000,
  outputTokens: 500,
  estimated: false,
  latencyMs: 200,
  firstTokenMs: 50,
  ok: true,
  ...overrides,
});

describe("resultUsage", () => {
  it("totals the calls and prices them: hand-computed", () => {
    // 2 calls of 1,000 in and 500 out: 2,000 in at 1/M and 1,000 out at 2/M = 0.002 + 0.002
    const usage = resultUsage([call(), call()], PRICES);
    expect(usage).toEqual({
      calls: 2,
      failedCalls: 0,
      promptTokens: 2000,
      outputTokens: 1000,
      embeddedTokens: 0,
      modelMs: 400,
      cost: expect.closeTo(0.004, 12) as number,
      unpricedTokens: 0,
    });
  });

  it("says nothing, not zero, when there were no calls", () => {
    expect(resultUsage([], PRICES)).toBeUndefined();
    expect(resultUsage(undefined, PRICES)).toBeUndefined();
  });

  it("counts the tokens of an unpriced model apart", () => {
    const usage = resultUsage([call({ modelId: "ollama:free" })], PRICES);
    expect(usage).toMatchObject({ cost: 0, unpricedTokens: 1500 });
  });
});

describe("runExperiment: usage and cost", () => {
  const questions = [question("q001"), question("q002")];
  const setup = (overrides: Partial<RunExperimentDeps> = {}) => {
    const store = memoryStore();
    const system = fakeSystem({
      answer: () => ({
        retrieved: ranked(chunkAt(150, 160)),
        sources: ["s"],
        answered: true,
        latencyMs: { retrieval: 5 },
        usage: [call(), call({ promptTokens: 300, outputTokens: 0, kind: "embed", modelId: "x" })],
      }),
    });
    const deps: RunExperimentDeps = {
      experiment: { name: "exp", generation: false },
      variants: [variant("a")],
      dataset: { path: "d.jsonl", version: "v1" },
      questions,
      gold: goldFor(questions),
      factory: factoryOf(() => system),
      store,
      gitCommit: null,
      prices: PRICES,
      ...overrides,
    };
    return { deps, store };
  };

  it("puts the usage and cost of every call on each result", async () => {
    const { deps, store } = setup();
    await runExperiment(deps);
    expect(store.results[0]?.usage).toMatchObject({
      calls: 2,
      promptTokens: 1000,
      outputTokens: 500,
      cost: expect.closeTo(0.002, 12) as number,
      // the embedding is of a model with no price
      unpricedTokens: 300,
    });
  });

  it("sums the cost per 100 questions in the summary", async () => {
    const { deps } = setup();
    const summary = await runExperiment(deps);
    // 2 questions at 0.002 each: 0.004 in all, 0.2 per 100 questions
    expect(summary.variants[0]?.cost).toMatchObject({
      currency: "USD",
      total: expect.closeTo(0.004, 12) as number,
      per100Questions: expect.closeTo(0.2, 9) as number,
      calls: 4,
      promptTokens: 2000,
      outputTokens: 1000,
      unpricedTokens: 600,
    });
  });

  it("leaves the cost out of a run whose system made no recorded call", async () => {
    const store = memoryStore();
    const { deps } = setup({ store, factory: factoryOf(() => fakeSystem()) });
    const summary = await runExperiment(deps);
    expect(store.results[0]).not.toHaveProperty("usage");
    expect(summary.variants[0]).not.toHaveProperty("cost");
  });

  it("works without a price table: tokens are counted and nothing costs anything", async () => {
    const store = memoryStore();
    const everything: Record<string, unknown> = { ...setup({ store }).deps };
    delete everything["prices"];
    const summary = await runExperiment(everything as unknown as RunExperimentDeps);
    expect(store.results[0]?.usage).toMatchObject({ cost: 0, unpricedTokens: 1800 });
    expect(summary.variants[0]?.cost?.currency).toBe("");
  });

  describe("the judge", () => {
    /** A judge that is a model: it calls a metered provider, as the real one does. */
    const judgingWith = (llm: LlmProvider): AnswerJudge => {
      const metered = new MeteredProvider(llm);
      return {
        modelId: "judge",
        judge: async () => {
          await drain(metered.chat([{ role: "user", content: "j" }]));
          return judgement(1, 1, 1);
        },
      };
    };

    it("is counted on its own trace, apart from the system", async () => {
      const model: LlmProvider = {
        modelId: "openai-compatible:cheap",
        async *chat() {
          await Promise.resolve();
          yield { kind: "text", text: "{}" } as const;
          yield { kind: "end", reason: "stop", promptTokens: 400, outputTokens: 100 } as const;
        },
      };
      const judge = judgingWith(model);
      const { deps, store } = setup({
        experiment: { name: "exp", generation: true },
        judge,
        factory: factoryOf(() =>
          fakeSystem({
            answer: () => ({
              retrieved: ranked(chunkAt(150, 160)),
              sources: ["s"],
              answered: true,
              answer: "An answer.",
              latencyMs: { retrieval: 5, generation: 5 },
              usage: [call()],
            }),
          }),
        ),
      });
      const summary = await runExperiment(deps);

      const first = store.results[0] as QuestionResult;
      // the system's usage is its own call only; the judge's call is not in it
      expect(first.usage).toMatchObject({ calls: 1, promptTokens: 1000 });
      expect(first.judgeUsage).toMatchObject({ calls: 1, promptTokens: 400, outputTokens: 100 });
      expect(summary.variants[0]?.cost?.judge).toMatchObject({
        calls: 2,
        promptTokens: 800,
        outputTokens: 200,
      });
      // 800 in at 1/M and 200 out at 2/M, over 2 questions, per 100
      expect(summary.variants[0]?.cost?.judge?.per100Questions).toBeCloseTo(
        ((800 * 1 + 200 * 2) / 1_000_000 / 2) * 100,
        9,
      );
    });

    it("keeps the calls that were recorded when the judge fails", async () => {
      const metered = new MeteredProvider({
        modelId: "openai-compatible:cheap",
        async *chat() {
          await Promise.resolve();
          yield { kind: "end", reason: "stop", promptTokens: 50, outputTokens: 5 } as const;
        },
      });
      const failing = {
        modelId: "judge",
        judge: async () => {
          await drain(metered.chat([{ role: "user", content: "j" }]));
          throw new Error("bad JSON");
        },
      };
      const { deps, store } = setup({
        experiment: { name: "exp", generation: true },
        judge: failing,
        factory: factoryOf(() =>
          fakeSystem({
            answer: () => ({
              retrieved: ranked(chunkAt(150, 160)),
              sources: ["s"],
              answered: true,
              answer: "An answer.",
              latencyMs: { retrieval: 5, generation: 5 },
            }),
          }),
        ),
      });
      await runExperiment(deps);
      expect(store.results[0]).toMatchObject({
        error: "judge: bad JSON",
        judgeUsage: { calls: 1, promptTokens: 50 },
      });
    });
  });
});

describe("summarizeVariant: cost", () => {
  const facts: VariantFacts = {
    variant: "v",
    configHash: "h",
    settings: {},
    configFile: "c.json",
    k: 5,
    models: { embedder: "e", generator: "g" },
    index: { namespace: "n", status: "built" },
    currency: "EUR",
  };
  const result = (id: string, overrides: Partial<QuestionResult> = {}): QuestionResult => ({
    experiment: "x",
    variant: "v",
    configHash: "h",
    gitCommit: null,
    datasetVersion: "v1",
    models: { embedder: "e", generator: "g" },
    questionId: id,
    kind: "factual",
    k: 5,
    retrieved: [],
    answered: true,
    latencyMs: { retrieval: 1 },
    ...overrides,
  });
  const usage = (cost: number) => ({
    calls: 2,
    failedCalls: 0,
    promptTokens: 100,
    outputTokens: 10,
    embeddedTokens: 5,
    modelMs: 30,
    cost,
    unpricedTokens: 0,
  });

  it("divides by the questions that ran, not by those with a recorded call", () => {
    const summary = summarizeVariant(facts, [
      result("q1", { usage: usage(0.01) }),
      result("q2"),
      result("q3", { usage: usage(0.03) }),
      result("q4", { usage: usage(9), error: "failed" }),
    ]);
    // 3 questions ran; q4 failed and is left out
    expect(summary.cost).toMatchObject({
      currency: "EUR",
      total: expect.closeTo(0.04, 12) as number,
      per100Questions: expect.closeTo((0.04 / 3) * 100, 9) as number,
      calls: 4,
    });
  });

  it("has no cost when no result recorded usage", () => {
    expect(summarizeVariant(facts, [result("q1")])).not.toHaveProperty("cost");
  });

  it("keeps the judge apart", () => {
    const summary = summarizeVariant(facts, [
      result("q1", { usage: usage(0.01), judgeUsage: usage(0.5) }),
    ]);
    expect(summary.cost?.total).toBeCloseTo(0.01, 12);
    expect(summary.cost?.judge?.total).toBeCloseTo(0.5, 12);
  });

  it("is read by the trace helpers like everything else", () => {
    const trace = new Trace();
    withTrace(trace, () => {
      trace.start("model-call").end({ model: "m", promptTokens: 1, completed: true });
    });
    expect(usageOf(trace.snapshot().stages)).toHaveLength(1);
  });
});

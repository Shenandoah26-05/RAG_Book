import { describe, expect, it } from "vitest";
import type { QuestionResult } from "../../core/index.js";
import { percentile, summarizeVariant } from "./summarize.js";
import type { VariantFacts } from "./summarize.js";

const facts: VariantFacts = {
  variant: "v",
  configHash: "h",
  settings: {},
  configFile: "c.json",
  k: 5,
  models: { embedder: "e", generator: "g" },
  index: { namespace: "n", status: "built" },
};

function result(id: string, overrides: Partial<QuestionResult> = {}): QuestionResult {
  return {
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
    latencyMs: { retrieval: 10 },
    ...overrides,
  };
}
const scores = (hit: number, mrr: number) => ({
  hit,
  precision: hit / 5,
  recall: hit,
  mrr,
  ndcg: mrr,
});

describe("percentile", () => {
  it("is the nearest rank", () => {
    const values = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentile(values, 0.5)).toBe(50);
    expect(percentile(values, 0.95)).toBe(100);
    expect(percentile(values, 0.1)).toBe(10);
  });

  it("does not need sorted input, and does not change it", () => {
    const values = [3, 1, 2];
    expect(percentile(values, 0.5)).toBe(2);
    expect(values).toEqual([3, 1, 2]);
  });

  it("handles one value and none", () => {
    expect(percentile([7], 0.95)).toBe(7);
    expect(percentile([], 0.5)).toBe(0);
  });
});

describe("summarizeVariant", () => {
  it("averages retrieval scores over answerable questions", () => {
    const summary = summarizeVariant(facts, [
      result("q1", { retrieval: scores(1, 1) }),
      result("q2", { retrieval: scores(0, 0) }),
      result("q3", { kind: "unanswerable", answered: false }),
    ]);
    expect(summary.retrieval).toEqual({
      questions: 2,
      hit: 0.5,
      precision: 0.1,
      recall: 0.5,
      mrr: 0.5,
      ndcg: 0.5,
    });
    expect(summary.questions).toEqual({ total: 3, answerable: 2, unanswerable: 1, failed: 0 });
  });

  it("counts a failed question and leaves it out of every mean", () => {
    const summary = summarizeVariant(facts, [
      result("q1", { retrieval: scores(1, 1), latencyMs: { retrieval: 10 } }),
      result("q2", { error: "boom", latencyMs: { retrieval: 9999 } }),
    ]);
    expect(summary.questions.failed).toBe(1);
    expect(summary.retrieval?.questions).toBe(1);
    expect(summary.latencyMs.retrievalP95).toBe(10);
  });

  it("counts refusals on both sides", () => {
    const summary = summarizeVariant(facts, [
      result("q1", { kind: "unanswerable", answered: false }),
      result("q2", { kind: "unanswerable", answered: true }),
      result("q3", { answered: false, retrieval: scores(0, 0) }),
      result("q4", { answered: true, retrieval: scores(1, 1) }),
    ]);
    expect(summary.refusals).toEqual({ unanswerableRefused: 1, answerableRefused: 1 });
  });

  it("averages judged answers, and faithfulness only over answers that have it", () => {
    const generation = (
      faithfulness: number | undefined,
      relevance: number,
      correctness: number,
    ) => ({
      generation: {
        ...(faithfulness === undefined ? {} : { faithfulness }),
        relevance,
        correctness,
        promptVersions: [],
      },
    });
    const summary = summarizeVariant(facts, [
      result("q1", generation(1, 1, 1)),
      result("q2", generation(0.5, 0.5, 0)),
      result("q3", generation(undefined, 1, 0.5)),
      result("q4"),
    ]);
    expect(summary.generation).toEqual({
      judged: 3,
      faithfulness: 0.75,
      relevance: 2.5 / 3,
      correctness: 0.5,
    });
  });

  it("leaves out what was not measured", () => {
    const summary = summarizeVariant(facts, [result("q1", { kind: "unanswerable" })]);
    expect(summary).not.toHaveProperty("retrieval");
    expect(summary).not.toHaveProperty("generation");
    expect(summary.latencyMs).not.toHaveProperty("generationP50");
  });

  it("takes latency percentiles and sums tokens", () => {
    const summary = summarizeVariant(
      facts,
      [10, 20, 30, 40].map((retrieval, i) =>
        result(`q${i.toString()}`, {
          latencyMs: { retrieval, generation: retrieval * 10 },
          tokens: { prompt: 100, output: 10 },
        }),
      ),
    );
    expect(summary.latencyMs).toEqual({
      retrievalP50: 20,
      retrievalP95: 40,
      generationP50: 200,
      generationP95: 400,
    });
    expect(summary.tokens).toEqual({ prompt: 400, output: 40 });
  });

  it("keeps the facts it was given", () => {
    expect(summarizeVariant(facts, [])).toMatchObject(facts);
  });
});

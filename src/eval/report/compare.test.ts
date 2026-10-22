import { describe, expect, it } from "vitest";
import { bootstrapInterval, compareVariants, isMetricName, METRIC_NAMES } from "./compare.js";
import { makeRun, qid } from "./report.testing.js";

describe("compareVariants", () => {
  // baseline: 0.5 0.5 0.5 1 | variant: 0.7 0.4 0.5 1 -> +0.2, -0.1, 0, 0
  const { results } = makeRun({
    base: { ndcg: [0.5, 0.5, 0.5, 1] },
    other: { ndcg: [0.7, 0.4, 0.5, 1] },
  });

  it("counts wins, losses and ties, question by question", () => {
    const c = compareVariants(results, "base", "other", "ndcg");
    expect([c.wins, c.losses, c.ties]).toEqual([1, 1, 2]);
    expect(c.questions.map((q) => [q.questionId, q.outcome])).toEqual([
      ["q001", "win"],
      ["q002", "loss"],
      ["q003", "tie"],
      ["q004", "tie"],
    ]);
  });

  it("takes the mean of the differences: hand-computed", () => {
    const c = compareVariants(results, "base", "other", "ndcg");
    expect(c.meanDifference).toBeCloseTo((0.2 - 0.1) / 4, 12);
    expect(c.questions[0]).toMatchObject({ baseline: 0.5, variant: 0.7 });
    expect(c.questions[0]?.difference).toBeCloseTo(0.2, 12);
  });

  it("calls differences below the float tolerance ties", () => {
    const { results: noisy } = makeRun({
      a: { ndcg: [0.1 + 0.2] },
      b: { ndcg: [0.3] },
    });
    expect(compareVariants(noisy, "a", "b", "ndcg").ties).toBe(1);
  });

  it("compares only the questions both have a score for", () => {
    const { results: mixed } = makeRun({
      base: { ndcg: [0.5, undefined, 0.5, 0.5], failed: [2] },
      other: { ndcg: [0.9, undefined, 0.9, 0.9], failed: [3] },
    });
    // q002 is unanswerable (no score), q003 failed for base, q004 failed for other
    const c = compareVariants(mixed, "base", "other", "ndcg");
    expect(c.questions.map((q) => q.questionId)).toEqual(["q001"]);
  });

  it("reads generation metrics too", () => {
    const { results: judged } = makeRun({
      base: { ndcg: [1, 1], correctness: [0.5, 1] },
      other: { ndcg: [1, 1], correctness: [1, 0.5] },
    });
    const c = compareVariants(judged, "base", "other", "correctness");
    expect([c.wins, c.losses]).toEqual([1, 1]);
    expect(compareVariants(judged, "base", "other", "ndcg").ties).toBe(2);
  });

  it("says better only when the interval excludes 0", () => {
    const scores = Array.from({ length: 20 }, (_, i) => 0.3 + (i % 3) * 0.1);
    const { results: clear } = makeRun({
      base: { ndcg: scores },
      other: { ndcg: scores.map((s) => s + 0.2) },
      worse: { ndcg: scores.map((s) => s - 0.2) },
    });
    expect(compareVariants(clear, "base", "other", "ndcg")).toMatchObject({
      verdict: "better",
      interval: { low: expect.closeTo(0.2, 9) as number, high: expect.closeTo(0.2, 9) as number },
    });
    expect(compareVariants(clear, "base", "worse", "ndcg").verdict).toBe("worse");
  });

  it("says unclear for a mixed, noisy difference", () => {
    const { results: noisy } = makeRun({
      base: { ndcg: [0.2, 0.9, 0.4, 0.6, 0.3, 0.8] },
      other: { ndcg: [0.9, 0.3, 0.8, 0.2, 0.7, 0.4] },
    });
    const c = compareVariants(noisy, "base", "other", "ndcg");
    expect(c.verdict).toBe("unclear");
    expect(c.interval?.low).toBeLessThan(0);
    expect(c.interval?.high).toBeGreaterThan(0);
  });

  it("gives no interval, and an unclear verdict, for fewer than two questions", () => {
    const { results: tiny } = makeRun({ base: { ndcg: [0.2] }, other: { ndcg: [0.9] } });
    const c = compareVariants(tiny, "base", "other", "ndcg");
    expect(c).not.toHaveProperty("interval");
    expect(c.verdict).toBe("unclear");
  });

  it("has a zero mean and no questions when nothing can be compared", () => {
    const { results: none } = makeRun({
      base: { ndcg: [undefined] },
      other: { ndcg: [undefined] },
    });
    expect(compareVariants(none, "base", "other", "ndcg")).toMatchObject({
      questions: [],
      meanDifference: 0,
    });
  });

  it("rejects a variant with no results", () => {
    expect(() => compareVariants(results, "base", "ghost", "ndcg")).toThrow(
      /No results for variant "ghost"/,
    );
    expect(() => compareVariants(results, "ghost", "other", "ndcg")).toThrow(/ghost/);
  });
});

describe("bootstrapInterval", () => {
  const differences = [0.2, -0.1, 0.3, 0.05, -0.2, 0.15, 0.1, 0];

  it("is the same every time", () => {
    expect(bootstrapInterval(differences)).toEqual(bootstrapInterval(differences));
  });

  it("brackets the mean and is ordered", () => {
    const mean = differences.reduce((a, b) => a + b, 0) / differences.length;
    const interval = bootstrapInterval(differences);
    expect(interval?.low).toBeLessThanOrEqual(mean);
    expect(interval?.high).toBeGreaterThanOrEqual(mean);
    expect(interval?.low).toBeLessThan(interval?.high ?? 0);
  });

  it("is a single point when every difference is the same", () => {
    const interval = bootstrapInterval([0.25, 0.25, 0.25]);
    expect(interval?.low).toBeCloseTo(0.25, 12);
    expect(interval?.high).toBeCloseTo(0.25, 12);
  });

  it("narrows as there are more questions", () => {
    const wide = bootstrapInterval(differences);
    const narrow = bootstrapInterval(Array.from({ length: 8 }, () => differences).flat());
    expect((narrow?.high ?? 0) - (narrow?.low ?? 0)).toBeLessThan(
      (wide?.high ?? 0) - (wide?.low ?? 0),
    );
  });

  it("needs two or more differences", () => {
    expect(bootstrapInterval([])).toBeUndefined();
    expect(bootstrapInterval([0.5])).toBeUndefined();
  });

  it("depends on the seed", () => {
    expect(bootstrapInterval(differences, 1)).not.toEqual(bootstrapInterval(differences, 2));
  });
});

describe("metric names", () => {
  it("lists the retrieval and generation metrics", () => {
    expect(METRIC_NAMES).toEqual([
      "ndcg",
      "mrr",
      "recall",
      "hit",
      "precision",
      "correctness",
      "faithfulness",
      "relevance",
    ]);
    expect(isMetricName("ndcg")).toBe(true);
    expect(isMetricName("toString")).toBe(false);
    expect(qid(0)).toBe("q001");
  });
});

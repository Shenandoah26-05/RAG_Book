import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ExperimentSummary, QuestionResult, VariantSummary } from "../../core/index.js";
import { parseDataset } from "../dataset/index.js";
import type { Baseline, SmokeObservation } from "./baseline.js";
import { baselineSchema } from "./baseline.js";
import { compareToBaseline } from "./compare.js";
import { observeSmoke } from "./observe.js";
import { describeRegression } from "./report.js";

const baseline: Baseline = {
  dataset: "v1-smoke",
  k: 5,
  recall: 0.9,
  questions: { q001: 1, q002: 1, q003: 0.5, q004: 1 },
  margin: 0.05,
  configHash: "h1",
  recordedAt: "2026-10-22T10:00:00.000Z",
  gitCommit: "abc1234",
};

const observation = (questions: Record<string, number>, rest: Partial<SmokeObservation> = {}) => ({
  dataset: "v1-smoke",
  k: 5,
  recall: Object.values(questions).reduce((s, v) => s + v, 0) / Object.keys(questions).length,
  questions,
  configHash: "h1",
  ...rest,
});

describe("compareToBaseline", () => {
  it("passes when recall is unchanged", () => {
    const report = compareToBaseline(observation({ q001: 1, q002: 1, q003: 0.5, q004: 1 }), {
      ...baseline,
      recall: 0.875,
    });
    expect(report).toMatchObject({ verdict: "pass", drop: 0, worse: [], better: [] });
  });

  it("fails when recall falls by more than the margin, and lists the questions that got worse", () => {
    // baseline 0.875; now 3.5 / 4... q002 and q004 lost: (1 + 0 + 0.5 + 0) / 4 = 0.375
    const report = compareToBaseline(observation({ q001: 1, q002: 0, q003: 0.5, q004: 0 }), {
      ...baseline,
      recall: 0.875,
    });
    expect(report.verdict).toBe("regression");
    expect(report.drop).toBeCloseTo(0.5);
    expect(report.worse.map((c) => c.questionId).sort()).toEqual(["q002", "q004"]);
  });

  it("passes at exactly the margin: 0.9 - 0.85 is 0.05 up to rounding", () => {
    const report = compareToBaseline(
      { ...observation({ q001: 1 }), recall: 0.85 },
      { ...baseline, questions: { q001: 1 } },
    );
    expect(report.drop).not.toBe(0.05); // 0.05000000000000004 in floating point
    expect(report.verdict).toBe("pass");
  });

  it("fails just beyond the margin", () => {
    expect(
      compareToBaseline(
        { ...observation({ q001: 1 }), recall: 0.84 },
        { ...baseline, questions: { q001: 1 } },
      ).verdict,
    ).toBe("regression");
  });

  it("takes the margin from the call when given, else from the baseline", () => {
    const run = { ...observation({ q001: 1 }), recall: 0.6 };
    const stored = { ...baseline, questions: { q001: 1 } };
    expect(compareToBaseline(run, stored).verdict).toBe("regression");
    expect(compareToBaseline(run, stored, 0.5).verdict).toBe("pass");
  });

  it("lists better questions and suggests a new baseline when recall is clearly better", () => {
    const report = compareToBaseline(
      { ...observation({ q001: 1, q003: 1 }), recall: 1 },
      { ...baseline, recall: 0.75, questions: { q001: 1, q003: 0.5 } },
    );
    expect(report.verdict).toBe("pass");
    expect(report.better).toEqual([{ questionId: "q003", before: 0.5, after: 1 }]);
    expect(report.notes.join(" ")).toContain("--update-baseline");
  });

  it("is invalid, never a pass, for another dataset or cutoff", () => {
    const run = observation({ q001: 1, q002: 1, q003: 0.5, q004: 1 });
    expect(compareToBaseline({ ...run, dataset: "v2" }, baseline)).toMatchObject({
      verdict: "invalid",
    });
    const other = compareToBaseline({ ...run, k: 3 }, baseline);
    expect(other.verdict).toBe("invalid");
    expect(other.problems.join(" ")).toContain("recall@5");
  });

  it("is invalid when the questions differ, naming them", () => {
    const report = compareToBaseline(observation({ q001: 1, q002: 1, q009: 1 }), baseline);
    expect(report.verdict).toBe("invalid");
    expect(report.problems.join(" ")).toContain("q003, q004");
    expect(report.problems.join(" ")).toContain("q009");
  });

  it("notes a different config without changing the verdict", () => {
    const report = compareToBaseline(
      observation({ q001: 1, q002: 1, q003: 0.5, q004: 1 }, { configHash: "h2" }),
      { ...baseline, recall: 0.875 },
    );
    expect(report.verdict).toBe("pass");
    expect(report.notes.join(" ")).toContain("configuration");
  });
});

describe("describeRegression", () => {
  it("says what changed and what to do on a failure", () => {
    const text = describeRegression(
      compareToBaseline(observation({ q001: 0, q002: 1, q003: 0.5, q004: 1 }), {
        ...baseline,
        recall: 0.875,
      }),
    );
    expect(text).toContain("recall@5: 0.625  baseline 0.875");
    expect(text).toContain("q001  1.000 -> 0.000");
    expect(text).toContain("FAIL");
    expect(text).toContain("--update-baseline");
  });

  it("says PASS, and lists problems for an invalid run", () => {
    const run = observation({ q001: 1, q002: 1, q003: 0.5, q004: 1 });
    expect(describeRegression(compareToBaseline(run, { ...baseline, recall: 0.875 }))).toContain(
      "PASS",
    );
    expect(describeRegression(compareToBaseline({ ...run, k: 3 }, baseline))).toContain(
      "could not compare",
    );
  });
});

const variant = (rest: Partial<VariantSummary> = {}): VariantSummary =>
  ({ variant: "default", configHash: "h1", k: 5, ...rest }) as VariantSummary;
const summaryOf = (variants: VariantSummary[]): ExperimentSummary =>
  ({ datasetVersion: "v1-smoke", variants }) as unknown as ExperimentSummary;
const resultOf = (questionId: string, recall: number | undefined, error?: string): QuestionResult =>
  ({
    questionId,
    ...(recall === undefined ? {} : { retrieval: { recall } }),
    ...(error === undefined ? {} : { error }),
  }) as QuestionResult;

describe("observeSmoke", () => {
  it("takes per-question recall and computes the mean from them", () => {
    const observed = observeSmoke(summaryOf([variant()]), [
      resultOf("q001", 1),
      resultOf("q002", 0.5),
      resultOf("q056", undefined), // unanswerable: nothing to find
    ]);
    expect(observed).toEqual({
      dataset: "v1-smoke",
      k: 5,
      recall: 0.75,
      questions: { q001: 1, q002: 0.5 },
      configHash: "h1",
    });
  });

  it("refuses a failed question instead of scoring it as 0", () => {
    expect(() =>
      observeSmoke(summaryOf([variant()]), [resultOf("q001", 1), resultOf("q002", 0, "timeout")]),
    ).toThrow("q002: timeout");
  });

  it("refuses a variant that could not run, no variant, two variants, and no answerable question", () => {
    expect(() => observeSmoke(summaryOf([variant({ error: "no index" })]), [])).toThrow("no index");
    expect(() => observeSmoke(summaryOf([]), [])).toThrow("exactly one variant");
    expect(() => observeSmoke(summaryOf([variant(), variant()]), [])).toThrow(
      "exactly one variant",
    );
    expect(() => observeSmoke(summaryOf([variant()]), [resultOf("q056", undefined)])).toThrow(
      "no answerable question",
    );
  });
});

describe("baselineSchema", () => {
  it("accepts a baseline and refuses an unknown key or a recall above 1", () => {
    expect(baselineSchema.safeParse(baseline).success).toBe(true);
    expect(baselineSchema.safeParse({ ...baseline, extra: 1 }).success).toBe(false);
    expect(baselineSchema.safeParse({ ...baseline, recall: 1.2 }).success).toBe(false);
  });
});

describe("the smoke dataset", () => {
  const read = (file: string) =>
    parseDataset(readFileSync(new URL(`../../../${file}`, import.meta.url), "utf8"));
  const smoke = read("evals/datasets/v1-smoke.jsonl");
  const full = read("evals/datasets/v1.jsonl");

  it("has 10 answerable questions", () => {
    expect(smoke).toHaveLength(10);
    expect(smoke.every((q) => q.kind !== "unanswerable")).toBe(true);
  });

  it("is a subset of v1: each question is identical to the one with its id, so the labels cannot drift", () => {
    for (const q of smoke) expect(q).toEqual(full.find((f) => f.id === q.id));
  });

  it("describes the same book as v1, under its own version", () => {
    const meta = (file: string) =>
      JSON.parse(
        readFileSync(new URL(`../../../evals/datasets/${file}`, import.meta.url), "utf8"),
      ) as {
        version: string;
        source: unknown;
      };
    expect(meta("v1-smoke.meta.json").source).toEqual(meta("v1.meta.json").source);
    expect(meta("v1-smoke.meta.json").version).toBe("v1-smoke");
  });
});

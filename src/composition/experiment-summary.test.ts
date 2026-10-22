import { describe, expect, it } from "vitest";
import type { ExperimentSummary, VariantSummary } from "../core/index.js";
import { describePlan, describeSummary } from "./experiment-summary.js";

const variant = (name: string, overrides: Partial<VariantSummary> = {}): VariantSummary => ({
  variant: name,
  configHash: "h",
  settings: {},
  configFile: "c.json",
  k: 5,
  models: { embedder: "e", generator: "g" },
  index: { namespace: "n", status: "built" },
  questions: { total: 4, answerable: 3, unanswerable: 1, failed: 0 },
  retrieval: { questions: 3, hit: 0.9, precision: 0.25, recall: 0.8333, mrr: 0.7, ndcg: 0.65 },
  refusals: { unanswerableRefused: 1, answerableRefused: 0 },
  latencyMs: { retrievalP50: 12.4, retrievalP95: 80.6 },
  tokens: { prompt: 0, output: 0 },
  ...overrides,
});

const summary = (
  variants: VariantSummary[],
  overrides: Partial<ExperimentSummary> = {},
): ExperimentSummary => ({
  experiment: "retrievers",
  dataset: "evals/datasets/v1.jsonl",
  datasetVersion: "v1",
  gitCommit: "abcdef1234567",
  startedAt: "2026-10-22T10:00:00.000Z",
  finishedAt: "2026-10-22T10:01:00.000Z",
  generation: false,
  variants,
  ...overrides,
});

describe("describeSummary", () => {
  it("prints one aligned row per variant with rounded numbers", () => {
    const text = describeSummary(
      summary([variant("dense"), variant("hybrid", { k: 3 })]),
      "evals/results/x",
    );
    const lines = text.split("\n");
    expect(lines[0]).toBe("Experiment retrievers: 2 variants, dataset v1, commit abcdef1");
    expect(lines[2]).toMatch(/^variant\s+k\s+hit\s+prec\s+recall\s+mrr\s+ndcg\s+refused\s+p50ms/);
    expect(lines[3]).toMatch(
      /^dense\s+5\s+0\.90\s+0\.25\s+0\.83\s+0\.70\s+0\.65\s+1\/1\s+12\s+81\s+0$/,
    );
    expect(lines[4]).toMatch(/^hybrid\s+3\s+/);
    expect(text).toContain("Results: evals/results/x");
  });

  it("adds the generation columns only when answers were generated", () => {
    const plain = describeSummary(summary([variant("a")]), "x");
    expect(plain).not.toContain("faith");
    const generated = describeSummary(
      summary(
        [
          variant("a", {
            generation: { judged: 3, faithfulness: 0.5, relevance: 1, correctness: 0.25 },
          }),
        ],
        { generation: true },
      ),
      "x",
    );
    expect(generated).toMatch(/faith\s+relev\s+correct/);
    expect(generated).toMatch(/0\.50\s+1\.00\s+0\.25/);
  });

  it("shows a dash for what was not measured, and for no unanswerable questions", () => {
    const text = describeSummary(
      summary([
        variant("a", {
          retrieval: undefined,
          questions: { total: 1, answerable: 1, unanswerable: 0, failed: 1 },
        }),
      ]),
      "x",
    );
    expect(text.split("\n")[3]).toMatch(/^a\s+5\s+-\s+-\s+-\s+-\s+-\s+-\s+\d+\s+\d+\s+1$/);
  });

  it("lists variants that could not run, with the reason", () => {
    const text = describeSummary(
      summary([variant("ok"), variant("bad", { error: "Unknown retriever" })]),
      "x",
    );
    expect(text).toContain("Could not run:\n  bad: Unknown retriever");
    expect(text).not.toMatch(/^bad\s+5/m);
  });

  it("says when nothing ran, and leaves out the commit when there is none", () => {
    const text = describeSummary(
      summary([variant("bad", { error: "boom" })], { gitCommit: null }),
      "x",
    );
    expect(text).toContain("No variant ran.");
    expect(text.split("\n")[0]).not.toContain("commit");
  });
});

describe("describePlan", () => {
  it("lists the variants and says what would be measured", () => {
    const text = describePlan(
      {
        name: "retrievers",
        description: "compare",
        generation: true,
        dataset: "d.jsonl",
        datasetVersion: "v1",
        questions: 42,
        variants: [
          { name: "a", settings: {} },
          { name: "b", settings: {} },
        ],
      },
      "evals/results/retrievers/now",
    );
    expect(text).toContain("Experiment retrievers: compare");
    expect(text).toContain("42 questions, answers generated and judged");
    expect(text).toContain("2 variants:\n  a\n  b");
    expect(text).toContain("would go to evals/results/retrievers/now");
  });
});

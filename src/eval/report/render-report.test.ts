import { describe, expect, it } from "vitest";
import { renderReport } from "./render-report.js";
import { makeRun } from "./report.testing.js";

/** Twelve questions with a clear gap: `better` wins on all, `same` copies the baseline. Mean 0.45. */
const scores = [0.3, 0.5, 0.4, 0.6, 0.2, 0.7, 0.5, 0.4, 0.3, 0.6, 0.5, 0.4];
const clear = () =>
  makeRun({
    base: { ndcg: scores, retrievalMs: 20, tokens: { prompt: 1000, output: 100 } },
    better: { ndcg: scores.map((s) => s + 0.2), retrievalMs: 40, indexStatus: "built" },
    same: { ndcg: scores },
  });

const section = (markdown: string, heading: string): string => {
  const start = markdown.indexOf(`## ${heading}`);
  expect(start, `section ${heading}`).toBeGreaterThanOrEqual(0);
  const next = markdown.indexOf("\n## ", start + 1);
  return markdown.slice(start, next === -1 ? undefined : next);
};

describe("renderReport", () => {
  it("has the sections a decision needs, in order", () => {
    const text = renderReport(clear());
    const headings = [...text.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    expect(headings).toEqual([
      "Summary",
      "Metrics per variant",
      "Against the baseline",
      "Latency and token cost",
      "Refusals",
      "Caveats",
      "Configs",
    ]);
    expect(text.startsWith("# Experiment exp: A/B report\n")).toBe(true);
    expect(text.endsWith("\n")).toBe(true);
  });

  it("names the dataset, commit, baseline and metric in the header", () => {
    const header = renderReport({ ...clear(), source: "evals/results/exp/now" }).split("\n## ")[0];
    expect(header).toContain("> Compare things");
    expect(header).toContain("`evals/datasets/v1.jsonl` (version v1)");
    expect(header).toContain("12 (12 answerable, 0 unanswerable)");
    expect(header).toContain("`abcdef1234567`");
    expect(header).toContain("| Baseline | `base` |");
    expect(header).toContain("nDCG, higher is better");
    expect(header).toContain("`evals/results/exp/now`");
  });

  it("ranks variants by the metric, best first, with the best in bold", () => {
    const table = section(renderReport(clear()), "Metrics per variant");
    const rows = table.split("\n").filter((l) => l.startsWith("| `"));
    expect(rows.map((r) => r.split("|")[1]?.trim())).toEqual([
      "`better`",
      "`base` (baseline)",
      "`same`",
    ]);
    expect(rows[0]).toContain("**0.65**");
    expect(rows[1]).not.toContain("**0.45**");
  });

  it("states a clear difference with its interval and counts", () => {
    const summary = section(renderReport(clear()), "Summary");
    expect(summary).toContain(
      "`better` scores highest (0.65), against 0.45 for the baseline `base`",
    );
    expect(summary).toContain(
      "`better` is **better** than the baseline on nDCG: +0.20, 95% interval [+0.20, +0.20]; 12 questions better, 0 worse, 0 the same.",
    );
    expect(summary).toContain("`same` is **no clear difference** than the baseline");
    expect(summary).not.toContain("No variant is clearly different");
  });

  it("warns against choosing when nothing is clearly different", () => {
    const text = renderReport(
      makeRun({
        base: { ndcg: [0.2, 0.9, 0.4, 0.6, 0.3, 0.8] },
        other: { ndcg: [0.9, 0.3, 0.8, 0.2, 0.7, 0.4] },
      }),
    );
    const summary = section(text, "Summary");
    expect(summary).toContain("(the difference could be chance)");
    expect(summary).toContain("**No variant is clearly different from the baseline.**");
    expect(summary).toContain("Do not choose between them on this evidence");
  });

  it("lists the biggest wins and losses with the question ids", () => {
    // differences +0.4, +0.1, -0.1, -0.4: two wins, two losses, mean change 0
    const text = renderReport({
      ...makeRun({
        base: { ndcg: [0.5, 0.5, 0.5, 0.5] },
        other: { ndcg: [0.9, 0.6, 0.4, 0.1] },
      }),
      top: 1,
    });
    const part = section(text, "Against the baseline");
    expect(part).toContain("| `other` | 2 | 2 | 0 | +0.00 |");
    expect(part).toContain("Biggest wins (up to 1):");
    expect(part).toContain("| `q001` | factual | 0.50 | 0.90 | +0.40 |");
    expect(part).not.toContain("`q002`");
    expect(part).toContain("| `q004` | factual | 0.50 | 0.10 | -0.40 |");
  });

  it("compares with the baseline asked for, and ranks by the metric asked for", () => {
    const text = renderReport({ ...clear(), baseline: "better", metric: "mrr" });
    expect(text).toContain("| Baseline | `better` |");
    expect(text).toContain("MRR, higher is better");
    expect(section(text, "Summary")).toContain("`base` is **worse** than the baseline on MRR");
  });

  it("reports latency, tokens and whether the index was built", () => {
    // tokens are per result: 12 questions of 1,000 + 100
    const table = section(renderReport(clear()), "Latency and token cost");
    expect(table).toContain(
      "| `base` | 20 | 20 | 12,000 | 1,200 | 1,100 | reused (recursive__ollama-embed) |",
    );
    expect(table).toContain("| `better` | 40 | 40 | 0 | 0 | 0 | built (recursive__ollama-embed) |");
    expect(table).not.toContain("generation p50");
  });

  describe("with generated answers", () => {
    const judged = () =>
      makeRun(
        {
          base: { ndcg: [0.5, 0.5, 0.5], correctness: [0.5, 0.5, 0.5] },
          other: { ndcg: [0.5, 0.5, 0.5], correctness: [1, 1, 0.5] },
        },
        { generation: true },
      );

    it("adds the generation columns", () => {
      const text = renderReport(judged());
      expect(section(text, "Metrics per variant")).toMatch(
        /faithfulness \| relevance \| correctness/,
      );
      expect(section(text, "Latency and token cost")).toContain("generation p50");
      expect(section(text, "Caveats")).toContain("small local language model acting as judge");
      expect(text).toContain("| Answers | generated and judged |");
    });

    it("can rank by correctness", () => {
      const text = renderReport({ ...judged(), metric: "correctness" });
      expect(section(text, "Summary")).toContain("`other` scores highest (0.83)");
    });
  });

  describe("caveats", () => {
    const caveats = (input: ReturnType<typeof makeRun>) => section(renderReport(input), "Caveats");

    it("warns about few questions, and says retrieval-only measures finding, not answering", () => {
      const text = caveats(clear());
      expect(text).toContain("Only 12 answerable questions");
      expect(text).toContain("*finds* the right passages");
      expect(text).toContain("One run per variant");
    });

    it("warns when the variants retrieve different numbers of chunks", () => {
      expect(
        caveats(makeRun({ a: { ndcg: [0.5, 0.5], k: 3 }, b: { ndcg: [0.5, 0.5], k: 5 } })),
      ).toContain("different numbers of chunks");
      expect(caveats(clear())).not.toContain("different numbers of chunks");
    });

    it("names the variants whose questions failed", () => {
      expect(
        caveats(
          makeRun({ a: { ndcg: [0.5, 0.5, 0.5], failed: [1] }, b: { ndcg: [0.5, 0.5, 0.5] } }),
        ),
      ).toContain("Questions failed for `a`");
    });

    it("lists variants that could not run, and leaves them out of the tables", () => {
      const run = makeRun(
        { a: { ndcg: [0.5, 0.5] } },
        { failedVariants: { broken: "Unknown retriever" } },
      );
      const text = renderReport(run);
      expect(section(text, "Caveats")).toContain("`broken` (Unknown retriever)");
      expect(section(text, "Metrics per variant")).not.toContain("broken");
      expect(section(text, "Configs")).toContain("Could not run: Unknown retriever");
    });

    it("does not warn about few questions for a big dataset", () => {
      const many = Array.from({ length: 120 }, () => 0.5);
      expect(caveats(makeRun({ a: { ndcg: many }, b: { ndcg: many } }))).not.toContain(
        "answerable questions. Small gaps",
      );
    });
  });

  it("includes every variant's config, so a saved report says what was compared", () => {
    const run = clear();
    const text = renderReport({
      ...run,
      configs: { base: { retrieval: { strategy: "dense" } }, better: { retrieval: { k: 9 } } },
    });
    const configs = section(text, "Configs");
    expect(configs).toContain("### `base`");
    expect(configs).toContain("| Config hash | `hash-base` |");
    expect(configs).toContain("| Config file | `evals/results/exp/now/configs/base.json` |");
    expect(configs).toContain('```json\n{\n  "retrieval": {\n    "strategy": "dense"\n  }\n}\n```');
    expect(configs).toContain('"k": 9');
    // `same` had no config given: the table is there, the block is not
    expect(configs).toContain("### `same`");
  });

  it("shows refusals for unanswerable and answerable questions", () => {
    const run = makeRun({ a: { ndcg: [0.5, undefined, 0.5] } });
    expect(section(renderReport(run), "Refusals")).toContain("| `a` | 1 of 1 | 0 of 2 |");
  });

  it("is the same every time", () => {
    expect(renderReport(clear())).toBe(renderReport(clear()));
  });

  it("does not let a variant name break a table", () => {
    const run = makeRun({ "a|b": { ndcg: [0.5, 0.5] } });
    expect(renderReport(run)).toContain("`a\\|b`");
  });

  it("handles a single variant", () => {
    const text = renderReport(makeRun({ only: { ndcg: [0.5, 0.6] } }));
    expect(section(text, "Summary")).toContain("nothing to compare it with");
    expect(text).not.toContain("## Against the baseline");
  });

  describe("problems", () => {
    it("needs a variant that ran", () => {
      const run = makeRun({}, { failedVariants: { broken: "x" } });
      expect(() => renderReport(run)).toThrow(/No variant ran/);
    });

    it("rejects a baseline that did not run", () => {
      expect(() => renderReport({ ...clear(), baseline: "ghost" })).toThrow(
        /baseline "ghost" is not a variant that ran.*base, better, same/,
      );
    });

    it("explains a metric the run does not have", () => {
      expect(() => renderReport({ ...clear(), metric: "correctness" })).toThrow(
        /did not generate answers/,
      );
      expect(() =>
        renderReport({ ...makeRun({ a: { ndcg: [undefined, undefined] } }), metric: "ndcg" }),
      ).toThrow(/no answerable questions/);
    });
  });
});

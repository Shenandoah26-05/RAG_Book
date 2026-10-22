import { describe, expect, it } from "vitest";
import type { ExperimentSummary, VariantCost, VariantSummary } from "../../core/index.js";
import { costSection } from "./cost-section.js";
import { parseResults, parseSummary } from "./parse-results.js";
import { renderReport } from "./render-report.js";
import { makeRun } from "./report.testing.js";

const cost = (overrides: Partial<VariantCost> = {}): VariantCost => ({
  currency: "USD",
  total: 0.05,
  per100Questions: 0.5,
  calls: 40,
  promptTokens: 20_000,
  outputTokens: 2_000,
  embeddedTokens: 400,
  modelMs: 80_000,
  unpricedTokens: 0,
  ...overrides,
});

/** A run of two variants with the given costs, over 10 questions each. */
function run(costs: Record<string, VariantCost | undefined>) {
  const base = makeRun(
    Object.fromEntries(
      Object.keys(costs).map((name) => [name, { ndcg: Array.from({ length: 10 }, () => 0.5) }]),
    ),
  );
  const variants: VariantSummary[] = base.summary.variants.map((v) => {
    const c = costs[v.variant];
    return c === undefined ? v : { ...v, cost: c };
  });
  const summary: ExperimentSummary = { ...base.summary, variants };
  return { ...base, summary };
}

describe("costSection", () => {
  it("is empty when no variant recorded any usage", () => {
    expect(costSection(run({ a: undefined }).summary.variants)).toEqual([]);
  });

  it("gives money per 100 questions and the calls, tokens and time per question", () => {
    // 40 calls, 20,000 in, 2,000 out and 80 s over 10 questions
    const text = costSection(run({ a: cost() }).summary.variants).join("\n");
    expect(text).toContain("### Cost per 100 questions");
    expect(text).toContain("cost per 100 (USD)");
    expect(text).toContain("| `a` | 0.50 | 4.0 | 2,000 | 200 | 8,000 |");
    expect(text).toContain("Money is in USD, from the `pricing` table of the config.");
  });

  it("shows a fraction of a cent as it is", () => {
    const text = costSection(run({ a: cost({ per100Questions: 0.0123 }) }).summary.variants).join(
      "\n",
    );
    expect(text).toContain("| `a` | 0.01 |");
    expect(
      costSection(run({ a: cost({ per100Questions: 0.00045 }) }).summary.variants).join("\n"),
    ).toContain("| `a` | 0.00045 |");
  });

  it("shows no money, and says why, when no model has a price", () => {
    const text = costSection(
      run({ a: cost({ currency: "USD", total: 0, per100Questions: 0, unpricedTokens: 22_000 }) })
        .summary.variants,
    ).join("\n");
    expect(text).not.toContain("cost per 100");
    expect(text).toContain("No price is set for these models, so no money is shown");
    expect(text).toContain("under `pricing` in the config");
    // the tokens are still there
    expect(text).toContain("| `a` | 4.0 | 2,000 | 200 | 8,000 |");
  });

  it("names the tokens that have no price when some models do", () => {
    const text = costSection(run({ a: cost({ unpricedTokens: 1500 }) }).summary.variants).join(
      "\n",
    );
    expect(text).toContain("1,500 tokens belong to models with no price");
  });

  it("lists the judge apart from the system", () => {
    const withJudge = cost({
      judge: {
        total: 0.2,
        per100Questions: 2,
        calls: 30,
        promptTokens: 9000,
        outputTokens: 600,
        unpricedTokens: 0,
      },
    });
    const text = costSection(run({ a: withJudge }).summary.variants).join("\n");
    expect(text).toContain("The judge, apart from the system:");
    expect(text).toContain("judge cost per 100 (USD)");
    expect(text).toContain("| `a` | 2.00 | 30 | 9,000 | 600 |");
    // the system's own cost is not changed by the judge
    expect(text).toContain("| `a` | 0.50 |");
  });

  it("leaves out a variant that recorded nothing, and counts only questions that ran", () => {
    const base = run({ a: cost(), b: undefined });
    const text = costSection(base.summary.variants).join("\n");
    expect(text).toContain("| `a` |");
    expect(text).not.toContain("| `b` |");
  });

  it("divides by the questions that ran, so a failed question does not cheapen a variant", () => {
    const base = run({ a: cost() });
    const failed = base.summary.variants.map((v) => ({
      ...v,
      questions: { ...v.questions, failed: 5 },
    }));
    // 40 calls over 5 questions, not 10
    expect(costSection(failed).join("\n")).toContain("| `a` | 0.50 | 8.0 |");
  });
});

describe("the report", () => {
  it("includes the cost under the latency section, and keeps its sections as they were", () => {
    const text = renderReport(run({ a: cost(), b: cost({ per100Questions: 3 }) }));
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
    const latency = text.slice(
      text.indexOf("## Latency and token cost"),
      text.indexOf("## Refusals"),
    );
    expect(latency).toContain("### Cost per 100 questions");
  });

  it("reports as before on a run that has no cost", () => {
    const text = renderReport(run({ a: undefined, b: undefined }));
    expect(text).not.toContain("Cost per 100");
  });
});

describe("reading the files", () => {
  const summaryJson = (summary: ExperimentSummary): string => JSON.stringify(summary);

  it("reads a summary with a cost", () => {
    const { summary } = run({
      a: cost({
        judge: {
          total: 1,
          per100Questions: 2,
          calls: 3,
          promptTokens: 4,
          outputTokens: 5,
          unpricedTokens: 0,
        },
      }),
    });
    expect(parseSummary(summaryJson(summary))).toEqual(summary);
  });

  it("still reads a summary written before costs were recorded", () => {
    const { summary } = run({ a: undefined });
    const parsed = parseSummary(summaryJson(summary));
    expect(parsed.variants[0]).not.toHaveProperty("cost");
  });

  it("reads results with usage and the judge's usage", () => {
    const { results } = makeRun({ a: { ndcg: [0.5] } });
    const usage = {
      calls: 3,
      failedCalls: 0,
      promptTokens: 100,
      outputTokens: 10,
      embeddedTokens: 4,
      modelMs: 300,
      cost: 0.001,
      unpricedTokens: 0,
    };
    const withUsage = results.map((r) => ({ ...r, usage, judgeUsage: usage }));
    expect(parseResults(withUsage.map((r) => JSON.stringify(r)).join("\n"))).toEqual(withUsage);
  });

  it("rejects usage that is not numbers", () => {
    const { results } = makeRun({ a: { ndcg: [0.5] } });
    const bad = { ...results[0], usage: { calls: "many" } };
    expect(() => parseResults(JSON.stringify(bad))).toThrow(/line 1 is not a result: usage/);
  });
});

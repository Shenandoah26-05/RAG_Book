import { describe, expect, it } from "vitest";
import { parseReportArgs } from "./report-args.js";

describe("parseReportArgs", () => {
  it("needs a run folder or an experiment name", () => {
    expect(parseReportArgs([])).toEqual({ error: "Name a run folder or an experiment" });
    expect(parseReportArgs(["a", "b"])).toEqual({
      error: "Expected one run folder or experiment, got 2",
    });
  });

  it("takes the target alone", () => {
    expect(parseReportArgs(["retrievers"])).toEqual({ target: "retrievers" });
  });

  it("reads every option, with a space or =", () => {
    expect(
      parseReportArgs([
        "retrievers",
        "--baseline",
        "dense",
        "--metric=mrr",
        "--top",
        "3",
        "--out",
        "docs/reports/x.md",
        "--results-dir=r",
      ]),
    ).toEqual({
      target: "retrievers",
      baseline: "dense",
      metric: "mrr",
      top: 3,
      out: "docs/reports/x.md",
      resultsDir: "r",
    });
  });

  it("rejects a metric that does not exist, including inherited names", () => {
    expect(parseReportArgs(["x", "--metric", "speed"])).toMatchObject({
      error: expect.stringContaining("--metric must be one of ndcg") as string,
    });
    expect(parseReportArgs(["x", "--metric", "toString"])).toHaveProperty("error");
  });

  it.each(["0", "-2", "1.5", "many"])("rejects --top %s", (top) => {
    expect(parseReportArgs(["x", "--top", top])).toMatchObject({
      error: expect.stringContaining("--top") as string,
    });
  });

  it("rejects a flag without a value, and an unknown flag", () => {
    expect(parseReportArgs(["x", "--baseline"])).toEqual({ error: "--baseline needs a value" });
    expect(parseReportArgs(["x", "--out", "--top"])).toEqual({ error: "--out needs a value" });
    expect(parseReportArgs(["x", "--bogus"])).toEqual({ error: "Unknown option --bogus" });
  });
});

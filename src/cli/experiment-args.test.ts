import { describe, expect, it } from "vitest";
import { parseExperimentArgs } from "./experiment-args.js";

describe("parseExperimentArgs", () => {
  it("needs one experiment file", () => {
    expect(parseExperimentArgs([])).toEqual({ error: "Name an experiment file" });
    expect(parseExperimentArgs(["a.json", "b.json"])).toEqual({
      error: "Expected one experiment file, got 2",
    });
  });

  it("runs everything by default", () => {
    expect(parseExperimentArgs(["evals/experiments/x.json"])).toEqual({
      file: "evals/experiments/x.json",
      only: [],
      dryRun: false,
    });
  });

  it("collects repeated --variant flags, with a space or =", () => {
    expect(parseExperimentArgs(["x.json", "--variant", "a", "--variant=b"])).toMatchObject({
      only: ["a", "b"],
    });
  });

  it("reads the limit, the folders and --dry-run", () => {
    expect(
      parseExperimentArgs([
        "x.json",
        "--limit",
        "5",
        "--dry-run",
        "--out=o",
        "--processed-dir",
        "p",
        "--index-dir",
        "i",
        "--cache-dir=c",
      ]),
    ).toEqual({
      file: "x.json",
      only: [],
      dryRun: true,
      limit: 5,
      outDir: "o",
      processedDir: "p",
      indexDir: "i",
      cacheDir: "c",
    });
  });

  it.each([["0"], ["-1"], ["2.5"], ["many"]])("rejects --limit %s", (limit) => {
    expect(parseExperimentArgs(["x.json", "--limit", limit])).toMatchObject({
      error: expect.stringContaining("--limit") as string,
    });
  });

  it("rejects a flag without a value, and an unknown flag", () => {
    expect(parseExperimentArgs(["x.json", "--variant"])).toEqual({
      error: "--variant needs a value",
    });
    expect(parseExperimentArgs(["x.json", "--out", "--dry-run"])).toEqual({
      error: "--out needs a value",
    });
    expect(parseExperimentArgs(["x.json", "--bogus"])).toEqual({ error: "Unknown option --bogus" });
  });
});

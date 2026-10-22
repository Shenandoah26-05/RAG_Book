import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeRun } from "../eval/report/report.testing.js";
import { buildReport } from "./build-report.js";

const scores = [0.3, 0.5, 0.4, 0.6, 0.2, 0.7, 0.5, 0.4];
const run = () =>
  makeRun({
    base: { ndcg: scores },
    better: { ndcg: scores.map((s) => s + 0.2) },
  });

let root: string;
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "rag-build-report-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Writes a finished run the way the experiment runner does. */
async function writeRun(
  dir: string,
  options: { configs?: boolean; resultsText?: string; summaryText?: string } = {},
): Promise<string> {
  const { results, summary } = run();
  await mkdir(path.join(dir, "configs"), { recursive: true });
  await writeFile(
    path.join(dir, "results.jsonl"),
    options.resultsText ?? `${results.map((r) => JSON.stringify(r)).join("\n")}\n`,
  );
  await writeFile(path.join(dir, "summary.json"), options.summaryText ?? JSON.stringify(summary));
  if (options.configs !== false) {
    await writeFile(
      path.join(dir, "configs", "base.json"),
      JSON.stringify({ retrieval: { strategy: "dense" } }),
    );
  }
  return dir;
}

describe("buildReport", () => {
  it("reads a run folder and reports on it, with the configs the run saved", async () => {
    const dir = await writeRun(path.join(root, "exp-a", "2026-10-22T10-00-00Z"));
    const report = await buildReport({ target: dir });
    expect(report.runDir).toBe(dir);
    expect(report.markdown).toContain("# Experiment exp: A/B report");
    expect(report.markdown).toContain('"strategy": "dense"');
    // the run folder is cited, with forward slashes, so the report reads the same on any system
    expect(report.markdown).toMatch(/\| Raw data \| `[^\\`]*2026-10-22T10-00-00Z` \|/);
  });

  it("takes an experiment name to mean its latest run", async () => {
    const resultsDir = path.join(root, "results");
    await writeRun(path.join(resultsDir, "retrievers", "2026-10-22T10-00-00Z"));
    const latest = await writeRun(path.join(resultsDir, "retrievers", "2026-10-22T10-00-00Z-2"));
    await writeRun(path.join(resultsDir, "retrievers", "2026-10-21T09-00-00Z"));
    const report = await buildReport({ target: "retrievers", resultsDir });
    expect(report.runDir).toBe(latest);
  });

  it("takes an experiment folder to mean its latest run", async () => {
    const experiment = path.join(root, "exp-folder");
    await writeRun(path.join(experiment, "2026-10-20T00-00-00Z"));
    const latest = await writeRun(path.join(experiment, "2026-10-22T00-00-00Z"));
    expect((await buildReport({ target: experiment })).runDir).toBe(latest);
  });

  it("passes the baseline, metric and top to the report", async () => {
    const dir = await writeRun(path.join(root, "exp-b", "now"));
    const report = await buildReport({ target: dir, baseline: "better", metric: "mrr", top: 1 });
    expect(report.markdown).toContain("| Baseline | `better` |");
    expect(report.markdown).toContain("MRR, higher is better");
    expect(report.markdown).toContain("Biggest wins (up to 1)");
  });

  it("still reports when a config file is missing", async () => {
    const dir = await writeRun(path.join(root, "exp-c", "now"), { configs: false });
    const report = await buildReport({ target: dir });
    expect(report.markdown).toContain("### `base`");
    expect(report.markdown).not.toContain("```json");
  });

  describe("problems", () => {
    it("says what to run when there is no finished run", async () => {
      await expect(
        buildReport({ target: "nothing-here", resultsDir: path.join(root, "empty") }),
      ).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
        message: expect.stringContaining("pnpm experiment") as string,
      });
    });

    it("does not treat an unfinished run (no summary) as a run", async () => {
      const dir = path.join(root, "unfinished", "now");
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "results.jsonl"), "");
      await expect(buildReport({ target: path.join(root, "unfinished") })).rejects.toThrow(
        /No finished run/,
      );
    });

    it("names a damaged results line", async () => {
      const dir = await writeRun(path.join(root, "exp-d", "now"), { resultsText: '{"cut' });
      await expect(buildReport({ target: dir })).rejects.toThrow(/line 1 is not JSON/);
    });

    it("names a damaged summary", async () => {
      const dir = await writeRun(path.join(root, "exp-e", "now"), { summaryText: "[]" });
      await expect(buildReport({ target: dir })).rejects.toThrow(/not an experiment summary/);
    });

    it("rejects a baseline that is not in the run", async () => {
      const dir = await writeRun(path.join(root, "exp-f", "now"));
      await expect(buildReport({ target: dir, baseline: "ghost" })).rejects.toThrow(/ghost/);
    });
  });
});

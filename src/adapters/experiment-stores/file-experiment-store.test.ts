import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExperimentSummary, QuestionResult } from "../../core/index.js";
import { FileExperimentStore, RESULTS_FILE, SUMMARY_FILE } from "./file-experiment-store.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "rag-exp-store-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const result = (questionId: string): QuestionResult => ({
  experiment: "e",
  variant: "v",
  configHash: "h",
  gitCommit: null,
  datasetVersion: "v1",
  models: { embedder: "ollama:m", generator: "ollama:g" },
  questionId,
  kind: "factual",
  k: 5,
  retrieved: [],
  answered: true,
  latencyMs: { retrieval: 3 },
});

const summary: ExperimentSummary = {
  experiment: "e",
  dataset: "evals/datasets/v1.jsonl",
  datasetVersion: "v1",
  gitCommit: "abc",
  startedAt: "2026-10-22T10:00:00.000Z",
  finishedAt: "2026-10-22T10:01:00.000Z",
  generation: false,
  variants: [],
};

describe("FileExperimentStore", () => {
  it("writes one JSON line per result, in order, as they arrive", async () => {
    const store = new FileExperimentStore(path.join(dir, "run"));
    await store.append(result("q001"));
    // already on disk before the run is over
    const early = await readFile(path.join(store.location, RESULTS_FILE), "utf8");
    expect(early.trim().split("\n")).toHaveLength(1);

    await store.append(result("q002"));
    const lines = (await readFile(path.join(store.location, RESULTS_FILE), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as QuestionResult);
    expect(lines.map((l) => l.questionId)).toEqual(["q001", "q002"]);
  });

  it("writes the summary as readable JSON", async () => {
    const store = new FileExperimentStore(dir);
    await store.finish(summary);
    const text = await readFile(path.join(dir, SUMMARY_FILE), "utf8");
    expect(JSON.parse(text)).toEqual(summary);
    expect(text).toContain("\n  ");
  });

  it("creates the folder, and writes a summary even when there are no results", async () => {
    const store = new FileExperimentStore(path.join(dir, "a", "b"));
    await store.finish(summary);
    expect(JSON.parse(await readFile(path.join(store.location, SUMMARY_FILE), "utf8"))).toEqual(
      summary,
    );
  });

  it("does not touch a record", async () => {
    const store = new FileExperimentStore(dir);
    const original = result("q001");
    await store.append(original);
    const [line] = (await readFile(path.join(dir, RESULTS_FILE), "utf8")).trim().split("\n");
    expect(JSON.parse(line ?? "")).toEqual(original);
  });
});

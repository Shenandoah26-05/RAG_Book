import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExperimentStore, ExperimentSummary, QuestionResult } from "../../core/index.js";

export const RESULTS_FILE = "results.jsonl";
export const SUMMARY_FILE = "summary.json";

/**
 * Saves one experiment run in a folder: `results.jsonl` (one JSON object per line, one line per
 * variant and question, written as each finishes) and `summary.json` (written at the end).
 *
 * JSONL is for appending and for tools: a stopped run keeps every finished line, and `jq`, a
 * notebook or the report of RAG-084 can read it a line at a time. Each line is complete on its own.
 */
export class FileExperimentStore implements ExperimentStore {
  readonly location: string;
  #ready: Promise<void> | undefined;

  /** @param dir the folder of this run; it is created on first write */
  constructor(dir: string) {
    this.location = dir;
  }

  async append(result: QuestionResult): Promise<void> {
    await this.#folder();
    await appendFile(path.join(this.location, RESULTS_FILE), `${JSON.stringify(result)}\n`, "utf8");
  }

  async finish(summary: ExperimentSummary): Promise<void> {
    await this.#folder();
    await writeFile(
      path.join(this.location, SUMMARY_FILE),
      `${JSON.stringify(summary, null, 2)}\n`,
      "utf8",
    );
  }

  #folder(): Promise<void> {
    this.#ready ??= mkdir(this.location, { recursive: true }).then(() => undefined);
    return this.#ready;
  }
}

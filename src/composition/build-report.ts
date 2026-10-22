import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parseResults, parseSummary, renderReport } from "../eval/index.js";
import type { MetricName } from "../eval/index.js";
import { RagError } from "../shared/index.js";
import { DEFAULT_RESULTS_DIR } from "./build-experiment.js";

export interface BuildReportOptions {
  /**
   * A run folder (`evals/results/retrievers/2026-10-22T10-01-02Z`), or an experiment name, which
   * means its latest run.
   */
  readonly target: string;
  /** Where experiment runs are. Default `evals/results`. */
  readonly resultsDir?: string;
  readonly baseline?: string;
  readonly metric?: MetricName;
  readonly top?: number;
}

export interface Report {
  readonly markdown: string;
  /** The run folder the report was made from. */
  readonly runDir: string;
}

async function isDirectory(folder: string): Promise<boolean> {
  try {
    return (await stat(folder)).isDirectory();
  } catch {
    return false;
  }
}

async function readText(file: string, what: string): Promise<string> {
  try {
    return await readFile(file, "utf8");
  } catch (cause) {
    throw new RagError("INVALID_ARGUMENT", `Cannot read ${what} ${file}`, { cause });
  }
}

/**
 * The run folder for what the user typed. Run folders are named by time (`2026-10-22T10-01-02Z`,
 * with `-2`, `-3` when two start in the same second), so the latest sorts last.
 */
async function resolveRunDir(target: string, resultsDir: string): Promise<string> {
  if (await isDirectory(target)) {
    if ((await readdir(target)).includes("summary.json")) return target;
    // an experiment folder: its latest run
    const runs = (await readdir(target, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    const latest = runs.at(-1);
    if (latest !== undefined) return resolveRunDir(path.join(target, latest), resultsDir);
  }
  const byName = path.join(resultsDir, target);
  if (byName !== target && (await isDirectory(byName))) return resolveRunDir(byName, resultsDir);
  throw new RagError(
    "INVALID_ARGUMENT",
    `No finished run found for "${target}". Give a run folder or an experiment name from ${resultsDir}, ` +
      'after "pnpm experiment <file>" has finished.',
  );
}

/**
 * Reads a finished experiment run and writes its report. The configs of the variants are read from
 * the run's own `configs/` folder, so the report holds what was really run.
 *
 * @throws RagError INVALID_ARGUMENT if there is no finished run, a file is damaged, or the baseline
 * or metric cannot be used
 */
export async function buildReport(options: BuildReportOptions): Promise<Report> {
  const runDir = await resolveRunDir(options.target, options.resultsDir ?? DEFAULT_RESULTS_DIR);
  const summary = parseSummary(await readText(path.join(runDir, "summary.json"), "the summary"));
  const results = parseResults(await readText(path.join(runDir, "results.jsonl"), "the results"));

  const configs: Record<string, unknown> = {};
  for (const variant of summary.variants) {
    try {
      configs[variant.variant] = JSON.parse(
        await readFile(path.join(runDir, "configs", `${variant.variant}.json`), "utf8"),
      ) as unknown;
    } catch {
      // a variant that never ran may have no config file; the report says what it knows
    }
  }

  return {
    runDir,
    markdown: renderReport({
      summary,
      results,
      configs,
      source: runDir.split(path.sep).join("/"),
      ...(options.baseline === undefined ? {} : { baseline: options.baseline }),
      ...(options.metric === undefined ? {} : { metric: options.metric }),
      ...(options.top === undefined ? {} : { top: options.top }),
    }),
  };
}

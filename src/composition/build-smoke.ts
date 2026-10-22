import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { RESULTS_FILE } from "../adapters/index.js";
import type { QuestionResult } from "../core/index.js";
import { baselineSchema, compareToBaseline, DEFAULT_MARGIN, observeSmoke } from "../eval/index.js";
import type { Baseline, RegressionReport } from "../eval/index.js";
import { RagError } from "../shared/index.js";
import { buildExperiment } from "./build-experiment.js";
import type { BuildExperimentOptions } from "./build-experiment.js";

/** The smoke experiment: the default setup on 10 questions, retrieval only. */
export const SMOKE_EXPERIMENT_FILE = "evals/experiments/smoke.json";
/** The stored result a run is compared with. Committed. */
export const SMOKE_BASELINE_FILE = "evals/baselines/smoke.json";

export interface SmokeOptions extends Omit<BuildExperimentOptions, "file" | "only" | "limit"> {
  /** Record this run as the new baseline instead of comparing with the old one. */
  readonly updateBaseline?: boolean;
  /** How far recall may fall. Default: the baseline's own margin. */
  readonly margin?: number;
  readonly baselineFile?: string;
  readonly experimentFile?: string;
}

export type SmokeOutcome =
  | { readonly kind: "checked"; readonly report: RegressionReport }
  | { readonly kind: "recorded"; readonly baseline: Baseline; readonly previous?: Baseline };

/** The baseline in `file`, or undefined if there is none yet. */
async function readBaseline(file: string): Promise<Baseline | undefined> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return undefined;
  }
  const parsed = baselineSchema.safeParse(JSON.parse(text));
  if (!parsed.success) {
    throw new RagError(
      "INVALID_ARGUMENT",
      `The baseline ${file} is not valid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }
  return parsed.data;
}

async function readResults(runDir: string): Promise<readonly QuestionResult[]> {
  const text = await readFile(path.join(runDir, RESULTS_FILE), "utf8");
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as QuestionResult);
}

/**
 * The retrieval regression check. It runs the smoke experiment with the same runner as
 * `pnpm experiment` (so the pipeline measured is the real one), then either compares recall with the
 * stored baseline or, with `updateBaseline`, records it as the new one.
 *
 * The baseline is read before the run, so a missing one fails at once instead of after the models
 * have worked.
 *
 * @throws RagError INVALID_ARGUMENT if there is no baseline (and none is being recorded), the
 * baseline file is invalid, or the run did not finish cleanly
 */
export async function runSmoke(
  options: SmokeOptions = {},
  signal?: AbortSignal,
): Promise<SmokeOutcome> {
  const {
    updateBaseline = false,
    margin,
    baselineFile = SMOKE_BASELINE_FILE,
    experimentFile = SMOKE_EXPERIMENT_FILE,
    ...rest
  } = options;
  const previous = await readBaseline(baselineFile);
  if (previous === undefined && !updateBaseline) {
    throw new RagError(
      "INVALID_ARGUMENT",
      `There is no baseline at ${baselineFile}. Record one with: pnpm eval:smoke --update-baseline`,
    );
  }

  const experiment = await buildExperiment({ ...rest, file: experimentFile });
  const summary = await experiment.run(signal);
  const observed = observeSmoke(summary, await readResults(experiment.location));

  if (updateBaseline) {
    const baseline: Baseline = {
      ...observed,
      margin: margin ?? previous?.margin ?? DEFAULT_MARGIN,
      recordedAt: summary.finishedAt,
      gitCommit: summary.gitCommit,
    };
    await mkdir(path.dirname(baselineFile), { recursive: true });
    await writeFile(baselineFile, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
    return { kind: "recorded", baseline, ...(previous === undefined ? {} : { previous }) };
  }
  // `previous` is defined here: the check above returns early otherwise
  return {
    kind: "checked",
    report: compareToBaseline(observed, previous as Baseline, margin),
  };
}

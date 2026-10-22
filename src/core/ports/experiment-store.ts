import type { ExperimentSummary, QuestionResult } from "../types/experiment.js";

/**
 * Where an experiment's results go. One store is one run: its results file and its summary.
 *
 * Rules every store follows:
 * 1. `append` writes the result before it returns, and results are kept in the order given, so a run
 *    that is stopped half-way still leaves every finished question on disk.
 * 2. `finish` writes the summary once, after the last result.
 * 3. A store never changes a record.
 */
export interface ExperimentStore {
  /** Where the run is saved, for the message at the end. */
  readonly location: string;
  append(result: QuestionResult): Promise<void>;
  finish(summary: ExperimentSummary): Promise<void>;
}

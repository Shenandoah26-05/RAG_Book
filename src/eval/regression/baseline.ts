import { z } from "zod";

/** How far recall may fall below the baseline before the check fails, unless the baseline says otherwise. */
export const DEFAULT_MARGIN = 0.05;

/**
 * The stored result the smoke check compares against (`evals/baselines/smoke.json`). It is recorded
 * on purpose with `pnpm eval:smoke --update-baseline` and committed, so a change to it shows up in
 * review like any other change.
 */
export const baselineSchema = z.strictObject({
  /** `version` of the smoke dataset it was recorded on. A different dataset is not comparable. */
  dataset: z.string().min(1),
  /** The cutoff recall was taken at (`retrieval.k`). */
  k: z.number().int().positive(),
  /** Mean recall@k over the smoke questions. */
  recall: z.number().min(0).max(1),
  /** Recall@k of each question, so a drop can be traced to the question that caused it. */
  questions: z.record(z.string(), z.number().min(0).max(1)),
  /** How far `recall` may fall before the check fails. */
  margin: z.number().min(0).max(1),
  /** The config the baseline ran with. A different hash is reported, not failed. */
  configHash: z.string().min(1),
  recordedAt: z.string().min(1),
  gitCommit: z.string().nullable(),
});
export type Baseline = z.infer<typeof baselineSchema>;

/** What one smoke run measured: the same facts as a baseline, minus the tolerance. */
export type SmokeObservation = Omit<Baseline, "margin" | "recordedAt" | "gitCommit">;

import type { Baseline, SmokeObservation } from "./baseline.js";

/** Recall is a mean of fractions: `0.9 - 0.85` is not exactly `0.05`, so equal-to-margin must pass. */
const EPSILON = 1e-9;

export type Verdict =
  /** Recall is within the margin of the baseline (or better). */
  | "pass"
  /** Recall fell by more than the margin. */
  | "regression"
  /** The run and the baseline cannot be compared; see `problems`. Not a pass. */
  | "invalid";

/** One question whose recall moved. */
export interface QuestionChange {
  readonly questionId: string;
  readonly before: number;
  readonly after: number;
}

export interface RegressionReport {
  readonly verdict: Verdict;
  readonly k: number;
  readonly baselineRecall: number;
  readonly recall: number;
  /** `baselineRecall - recall`: positive when retrieval got worse. */
  readonly drop: number;
  readonly margin: number;
  /** Questions that got worse, worst first. */
  readonly worse: readonly QuestionChange[];
  /** Questions that got better. */
  readonly better: readonly QuestionChange[];
  /** Why the run cannot be compared. Empty unless the verdict is `invalid`. */
  readonly problems: readonly string[];
  /** Things worth knowing that do not change the verdict, e.g. the config changed. */
  readonly notes: readonly string[];
}

/**
 * Decides whether retrieval got worse. A pure function of two small records:
 *
 *   regression  if  baselineRecall - recall  >  margin
 *
 * Only the mean decides. With 10 questions one lost question moves recall by about 0.1 (less for a
 * question with several passages), so the default margin of 0.05 fails on any real loss and ignores
 * nothing a person would call noise. Per-question changes are listed so the cause can be found.
 *
 * A run that cannot be compared with the baseline (another dataset or cutoff, other questions) is
 * `invalid`, never `pass`: a check that quietly passes because it compared the wrong things is worse
 * than no check.
 */
export function compareToBaseline(
  observed: SmokeObservation,
  baseline: Baseline,
  margin: number = baseline.margin,
): RegressionReport {
  const problems: string[] = [];
  if (observed.dataset !== baseline.dataset) {
    problems.push(
      `the baseline is for dataset "${baseline.dataset}" but this run used "${observed.dataset}"`,
    );
  }
  if (observed.k !== baseline.k) {
    problems.push(
      `the baseline is recall@${baseline.k.toString()} but this run is recall@${observed.k.toString()}`,
    );
  }
  const baselineIds = Object.keys(baseline.questions).sort();
  const observedIds = Object.keys(observed.questions).sort();
  if (baselineIds.join() !== observedIds.join()) {
    const missing = baselineIds.filter((id) => !(id in observed.questions));
    const extra = observedIds.filter((id) => !(id in baseline.questions));
    problems.push(
      `the questions differ from the baseline's` +
        (missing.length > 0 ? ` (no result for ${missing.join(", ")})` : "") +
        (extra.length > 0 ? ` (not in the baseline: ${extra.join(", ")})` : ""),
    );
  }

  const changes = baselineIds.flatMap((questionId): QuestionChange[] => {
    const before = baseline.questions[questionId];
    const after = observed.questions[questionId];
    return before === undefined || after === undefined ? [] : [{ questionId, before, after }];
  });
  const worse = changes
    .filter((c) => c.after < c.before - EPSILON)
    .sort((a, b) => a.after - a.before - (b.after - b.before));
  const better = changes.filter((c) => c.after > c.before + EPSILON);

  const drop = baseline.recall - observed.recall;
  const verdict: Verdict =
    problems.length > 0 ? "invalid" : drop > margin + EPSILON ? "regression" : "pass";

  const notes: string[] = [];
  if (observed.configHash !== baseline.configHash) {
    notes.push("the configuration differs from the one the baseline was recorded with");
  }
  if (verdict === "pass" && -drop > margin + EPSILON) {
    notes.push(
      "recall is clearly better than the baseline: record a new one with --update-baseline",
    );
  }

  return {
    verdict,
    k: observed.k,
    baselineRecall: baseline.recall,
    recall: observed.recall,
    drop,
    margin,
    worse,
    better,
    problems,
    notes,
  };
}

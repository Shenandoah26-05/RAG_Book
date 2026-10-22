// Public API of src/eval/report. Named exports only.
export { parseResults, parseSummary } from "./parse-results.js";
export {
  BOOTSTRAP_RESAMPLES,
  bootstrapInterval,
  compareVariants,
  isMetricName,
  METRIC_NAMES,
  METRICS,
} from "./compare.js";
export type { MetricName, Outcome, QuestionComparison, VariantComparison } from "./compare.js";
export { renderReport } from "./render-report.js";
export type { ReportInput } from "./render-report.js";

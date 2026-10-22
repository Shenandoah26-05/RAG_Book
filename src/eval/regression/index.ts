// Public API of src/eval/regression. Named exports only.
export { baselineSchema, DEFAULT_MARGIN } from "./baseline.js";
export type { Baseline, SmokeObservation } from "./baseline.js";
export { compareToBaseline } from "./compare.js";
export type { QuestionChange, RegressionReport, Verdict } from "./compare.js";
export { observeSmoke } from "./observe.js";
export { describeRegression } from "./report.js";

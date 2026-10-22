// Public API of src/eval/experiment. Named exports only.
export { expandVariants, MAX_VARIANTS } from "./expand-variants.js";
export type { ExperimentVariant } from "./expand-variants.js";
export { experimentSchema, SETTING_PATH, variantSchema, VARIANT_NAME } from "./schema.js";
export type { Experiment, VariantSpec } from "./schema.js";
export { runExperiment } from "./run-experiment.js";
export type { RunExperimentDeps } from "./run-experiment.js";
export { percentile, summarizeVariant } from "./summarize.js";
export type { VariantFacts } from "./summarize.js";
export type { SystemAnswer, VariantFactory, VariantSystem } from "./system.js";
export { NO_PRICES, resultUsage } from "./result-usage.js";

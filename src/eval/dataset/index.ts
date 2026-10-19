// Public API of src/eval/dataset. Named exports only.
export { parseDataset } from "./parse-dataset.js";
export { resolveGold } from "./resolve-gold.js";
export type { ResolvedGold } from "./resolve-gold.js";
export { QUESTION_KINDS, datasetMetaSchema, goldSchema, questionSchema } from "./schema.js";
export type { DatasetMeta, Gold, Question, QuestionKind } from "./schema.js";
export {
  MIN_QUESTIONS,
  MIN_UNANSWERABLE,
  checkDatasetAgainstDocument,
  checkDatasetShape,
  countByKind,
  formatDatasetViolations,
} from "./validate-dataset.js";
export type { DatasetViolation, DatasetViolationCode } from "./validate-dataset.js";

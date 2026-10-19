// Public API of src/eval/metrics. Named exports only.
export { goldPassages, judgeRetrieval, spansOverlap } from "./judge.js";
export type { GoldPassage, RetrievalJudgement } from "./judge.js";
export {
  hitAtK,
  ndcgAtK,
  precisionAtK,
  recallAtK,
  reciprocalRank,
  retrievalMetrics,
  scoreRetrieval,
} from "./metrics.js";
export type { RetrievalMetrics } from "./metrics.js";
export { meanMetrics } from "./aggregate.js";
export type { MeanRetrievalMetrics } from "./aggregate.js";

import { CrossEncoderScorer } from "../adapters/index.js";
import type { RagConfig } from "../config/index.js";
import type { Reranker, Retriever } from "../core/index.js";
import { RagError } from "../shared/index.js";
import { NoopReranker, RerankingRetriever, ScoringReranker } from "../strategies/index.js";

type Settings = RagConfig["rerank"];

// The one place that reads `rerank.enabled`. Everything else works with a `Reranker` or a
// `Retriever` and cannot tell whether reranking is on. Adding a reranker is one class and one line
// here (RAG-061 adds "llm", RAG-062 adds "cross-encoder").
const RERANKERS: ReadonlyMap<string, () => Reranker> = new Map<string, () => Reranker>([
  ["noop", () => new NoopReranker()],
  // the model is not loaded here, only on the first rerank
  ["cross-encoder", () => new ScoringReranker({ scorer: new CrossEncoderScorer() })],
]);

/** The names accepted in `rerank.strategy` (when `rerank.enabled` is true). */
export const rerankerNames = (): readonly string[] => [...RERANKERS.keys()];

/** What reranking is set to: the reranker, and how many candidates it should choose from. */
export interface RerankPlan {
  readonly reranker: Reranker;
  /** 0 when reranking is off: nothing extra is fetched. */
  readonly candidates: number;
}

/**
 * Turns `rerank.*` into a reranker. With `rerank.enabled` false the answer is the no-op reranker
 * whatever `rerank.strategy` says (the default config names "llm" while it is off). With it true,
 * `rerank.strategy` must name a known reranker.
 * @throws RagError CONFIG_INVALID if reranking is on and there is no such reranker
 */
export function resolveRerank(settings: Settings): RerankPlan {
  if (!settings.enabled) return { reranker: new NoopReranker(), candidates: 0 };
  const create = RERANKERS.get(settings.strategy);
  if (create === undefined) {
    throw new RagError(
      "CONFIG_INVALID",
      `Unknown reranker "${settings.strategy}" in rerank.strategy. ` +
        `Available rerankers: ${rerankerNames().join(", ")}`,
    );
  }
  return { reranker: create(), candidates: settings.candidates };
}

/** The reranker `rerank.*` asks for. */
export function buildReranker(settings: Settings): Reranker {
  return resolveRerank(settings).reranker;
}

/**
 * Wraps `retriever` so it fetches `rerank.candidates` chunks and returns the reranker's best `k`.
 * With reranking off it still wraps, with the no-op reranker, so callers never branch on the flag.
 * @throws RagError CONFIG_INVALID as `resolveRerank` does
 */
export function buildRerankingRetriever(retriever: Retriever, settings: Settings): Retriever {
  return new RerankingRetriever({ retriever, ...resolveRerank(settings) });
}

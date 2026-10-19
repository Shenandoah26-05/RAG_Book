import type { RagConfig } from "../config/index.js";
import type { Embedder, FusionStrategy, Retriever } from "../core/index.js";
import { RagError } from "../shared/index.js";
import {
  Bm25Retriever,
  DenseRetriever,
  HybridRetriever,
  ParentExpandingRetriever,
  RrfFusion,
  WeightedFusion,
} from "../strategies/index.js";
import { buildRerankingRetriever } from "./build-reranker.js";
import type { LoadedIndex } from "./load-index.js";

type Settings = RagConfig["retrieval"];

/** The names accepted in `retrieval.strategy`. */
export const retrievalStrategyNames = (): readonly string[] => ["dense", "bm25", "hybrid"];

/** Fusion strategies by `retrieval.fusion`. Weights are equal: config has no key for them yet. */
const FUSIONS: ReadonlyMap<string, () => FusionStrategy> = new Map<string, () => FusionStrategy>([
  ["rrf", () => new RrfFusion()],
  ["weighted", () => new WeightedFusion({ dense: 1, bm25: 1 })],
]);

/** The names accepted in `retrieval.fusion`. */
export const fusionNames = (): readonly string[] => [...FUSIONS.keys()];

/** Whether the strategy embeds the question, and so needs the embedding model running. */
export const usesEmbedder = (strategy: string): boolean =>
  strategy === "dense" || strategy === "hybrid";

export interface BuildRetrieverOptions {
  readonly retrieval: Settings;
  readonly rerank: RagConfig["rerank"];
  readonly index: LoadedIndex;
  /** Needed by "dense" and "hybrid": the model that built the index, so the question is embedded the same way. */
  readonly embedder?: Embedder;
  /** Wraps each of the base retrievers (dense, bm25), to watch what they find. */
  readonly wrap?: (retriever: Retriever) => Retriever;
}

/**
 * The retriever `retrieval.*` and `rerank.*` ask for, over a loaded index:
 *
 *   base (dense, bm25 or hybrid) -> expand children to parents -> rerank
 *
 * Parents are expanded only if the index has any, and reranking is always wrapped (with the no-op
 * reranker when it is off), so the caller never branches on either.
 * @throws RagError CONFIG_INVALID for an unknown strategy or fusion, or a strategy the index cannot
 *   serve (keyword search on an index built without a keyword index)
 */
export function buildRetriever(options: BuildRetrieverOptions): Retriever {
  const { retrieval, rerank, index, embedder, wrap = (r) => r } = options;

  const dense = (): Retriever => {
    if (embedder === undefined) {
      throw new RagError("INTERNAL", `Strategy "${retrieval.strategy}" needs an embedder`);
    }
    return wrap(
      new DenseRetriever({
        embedder,
        vectorStore: index.vectorStore,
        chunkStore: index.chunkStore,
      }),
    );
  };
  const keyword = (): Retriever => {
    if (index.keywordIndex === undefined) {
      throw new RagError(
        "CONFIG_INVALID",
        `Strategy "${retrieval.strategy}" needs the keyword index, but the index ${index.namespace} ` +
          'was built without one. Rebuild it with "pnpm index --force".',
      );
    }
    return wrap(new Bm25Retriever(index.keywordIndex, index.chunkStore));
  };

  let base: Retriever;
  switch (retrieval.strategy) {
    case "dense":
      base = dense();
      break;
    case "bm25":
      base = keyword();
      break;
    case "hybrid": {
      const createFusion = FUSIONS.get(retrieval.fusion);
      if (createFusion === undefined) {
        throw new RagError(
          "CONFIG_INVALID",
          `Unknown fusion "${retrieval.fusion}" in retrieval.fusion. Known fusions: ${fusionNames().join(", ")}`,
        );
      }
      base = new HybridRetriever({
        retrievers: [dense(), keyword()],
        fusion: createFusion(),
      });
      break;
    }
    default:
      throw new RagError(
        "CONFIG_INVALID",
        `Unknown retrieval strategy "${retrieval.strategy}" in retrieval.strategy. ` +
          `Known strategies: ${retrievalStrategyNames().join(", ")}`,
      );
  }

  const expanded =
    index.manifest.counts.parents > 0
      ? new ParentExpandingRetriever({ inner: base, chunkStore: index.chunkStore })
      : base;
  return buildRerankingRetriever(expanded, rerank);
}

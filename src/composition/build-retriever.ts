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
import type { LoadedIndex } from "./load-index.js";

type Settings = RagConfig["retrieval"];

export interface RetrieverContext {
  readonly index: LoadedIndex;
  /**
   * The model that embedded the index, so a question lands in the same vector space. Needed by the
   * strategies that embed the question (see `usesEmbedder`); `bm25` works without one.
   */
  readonly embedder?: Embedder;
  /**
   * Wraps each base retriever (dense, bm25) as it is built, to watch what it finds on its own.
   * The search command uses it; the pipeline does not.
   */
  readonly wrap?: (retriever: Retriever) => Retriever;
}

const FUSIONS: ReadonlyMap<string, () => FusionStrategy> = new Map<string, () => FusionStrategy>([
  ["rrf", () => new RrfFusion()],
  // the config has no weights yet, so both retrievers count the same
  ["weighted", () => new WeightedFusion({ dense: 1, bm25: 1 })],
]);

/** The names accepted in `retrieval.fusion`. */
export const fusionNames = (): readonly string[] => [...FUSIONS.keys()];

function dense({ embedder, index, wrap }: RetrieverContext): Retriever {
  if (embedder === undefined) {
    throw new RagError(
      "INTERNAL",
      "A dense or hybrid retriever needs an embedder for the question",
    );
  }
  const retriever = new DenseRetriever({
    embedder,
    vectorStore: index.vectorStore,
    chunkStore: index.chunkStore,
  });
  return wrap === undefined ? retriever : wrap(retriever);
}

function bm25({ index, wrap }: RetrieverContext): Retriever {
  if (index.keywordIndex === undefined) {
    throw new RagError(
      "INVALID_ARGUMENT",
      `The index ${index.manifest.namespace} has no keyword index, so keyword search is not available. ` +
        'Rebuild it with "pnpm index --force", or set retrieval.strategy to "dense".',
    );
  }
  const retriever = new Bm25Retriever(index.keywordIndex, index.chunkStore);
  return wrap === undefined ? retriever : wrap(retriever);
}

interface RetrieverKind {
  /** Whether it embeds the question, and so needs the embedding model running. */
  readonly embeds: boolean;
  readonly create: (context: RetrieverContext, fusion: string) => Retriever;
}

const RETRIEVERS: ReadonlyMap<string, RetrieverKind> = new Map<string, RetrieverKind>([
  ["dense", { embeds: true, create: (context) => dense(context) }],
  ["bm25", { embeds: false, create: (context) => bm25(context) }],
  [
    "hybrid",
    {
      embeds: true,
      create: (context, fusionName) => {
        const fusion = FUSIONS.get(fusionName);
        if (fusion === undefined) {
          throw new RagError(
            "CONFIG_INVALID",
            `Unknown fusion "${fusionName}" in retrieval.fusion. Known fusions: ${fusionNames().join(", ")}`,
          );
        }
        return new HybridRetriever({
          retrievers: [dense(context), bm25(context)],
          fusion: fusion(),
        });
      },
    },
  ],
]);

/** The names accepted in `retrieval.strategy`. */
export const retrieverNames = (): readonly string[] => [...RETRIEVERS.keys()];

/** Whether the strategy embeds the question. False for an unknown name (building it reports that). */
export const usesEmbedder = (strategy: string): boolean =>
  RETRIEVERS.get(strategy)?.embeds ?? false;

/**
 * Builds the retriever named in `retrieval.strategy` over a loaded index. If the index holds
 * parent chunks (the parent-child strategy) the retriever is wrapped so it answers with the
 * parents of the small chunks it finds; with no parents there is nothing to expand and it is not
 * wrapped. Reranking is not part of this: see `buildRerankingRetriever` and `resolveRerank`.
 * @throws RagError CONFIG_INVALID for an unknown strategy or fusion; INVALID_ARGUMENT if the
 *   strategy needs a keyword index and the index has none
 */
export function buildRetriever(settings: Settings, context: RetrieverContext): Retriever {
  const kind = RETRIEVERS.get(settings.strategy);
  if (kind === undefined) {
    throw new RagError(
      "CONFIG_INVALID",
      `Unknown retriever "${settings.strategy}" in retrieval.strategy. Known retrievers: ${retrieverNames().join(", ")}`,
    );
  }
  const retriever = kind.create(context, settings.fusion);
  return context.index.hasParents
    ? new ParentExpandingRetriever({ inner: retriever, chunkStore: context.index.chunkStore })
    : retriever;
}

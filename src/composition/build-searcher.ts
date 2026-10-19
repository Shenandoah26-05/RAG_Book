import { FileIndexReader } from "../adapters/index.js";
import { loadConfig } from "../config/index.js";
import type { Env } from "../config/index.js";
import type { MetadataFilter, RetrievedChunk } from "../core/index.js";
import { indexNamespace } from "../pipeline/index.js";
import { createConsoleLogger, RagError, Trace } from "../shared/index.js";
import type { Logger, StageRecord } from "../shared/index.js";
import { ObservedRetriever } from "../strategies/index.js";
import { buildEmbedder, DEFAULT_EMBEDDING_CACHE_DIR } from "./build-embedder.js";
import { buildRerankingRetriever } from "./build-reranker.js";
import { buildRetriever, usesEmbedder } from "./build-retriever.js";
import { openIndex } from "./load-index.js";
import { DEFAULT_VARIANTS_DIR, resolveVariant } from "./variants.js";

export interface BuildSearcherOptions {
  readonly argv?: readonly string[];
  readonly env?: Env;
  /** A variant (see `resolveVariant`) to use as the config file. Without one, the usual config. */
  readonly variant?: string;
  /** Where variants are looked up by name. Default `configs/variants`. */
  readonly variantsDir?: string;
  /** Where indexes are. Default `vectorStore.dir` from the config (`data/index`). */
  readonly indexDir?: string;
  /** Where embedding vectors are cached. Default `data/cache/embeddings`. */
  readonly cacheDir?: string;
  readonly logger?: Logger;
  readonly fetch?: typeof fetch;
}

export interface SearchOptions {
  /** How many chunks to return. Default `retrieval.k`. */
  readonly k?: number;
  readonly filter?: MetadataFilter;
  /** Which index: the chunker it was built with. Default `chunking.strategy`. */
  readonly chunker?: string;
  /** Which index: the embedder (`provider:model`) it was built with. Default from `embedding.*`. */
  readonly embedder?: string;
}

/** What one retriever found on its own, before fusion, parent expansion and reranking. */
export interface RetrieverTrace {
  readonly name: string;
  /** When its call started, in milliseconds from the start of the search. */
  readonly startMs: number;
  readonly durationMs: number;
  readonly results: readonly RetrievedChunk[];
}

/** Everything one search did, to be printed or saved as JSON. */
export interface SearchReport {
  readonly question: string;
  readonly k: number;
  readonly filter: MetadataFilter;
  readonly settings: {
    readonly strategy: string;
    readonly fusion: string;
    readonly rerank: { readonly enabled: boolean; readonly strategy: string };
  };
  readonly index: {
    readonly namespace: string;
    readonly location: string;
    readonly embedder: string;
    readonly chunker: string;
    readonly chunks: number;
    readonly vectors: number;
    readonly parents: number;
    readonly gitCommit: string | null;
    readonly createdAt: string;
    readonly loadMs: number;
  };
  /** Each retriever that ran, in the order it finished. One for dense and bm25, two for hybrid. */
  readonly retrievers: readonly RetrieverTrace[];
  /** The name of the retriever that gave `results`, e.g. "hybrid+parents". */
  readonly retriever: string;
  /**
   * What the reranker was given, in the retriever's own order: the fused (and parent-expanded) list,
   * `rerank.candidates` long when reranking is on. With reranking off it is the same list as
   * `results`, because the no-op reranker changes nothing. Comparing it with `results` shows what
   * reranking did.
   */
  readonly candidates: readonly RetrievedChunk[];
  /** What the pipeline would use: fused, expanded to parents and reranked as configured. */
  readonly results: readonly RetrievedChunk[];
  /** Milliseconds for the whole search, not counting the index load. */
  readonly totalMs: number;
  readonly stages: readonly StageRecord[];
}

export interface Searcher {
  search(question: string, options?: SearchOptions): Promise<SearchReport>;
}

/**
 * Reads the configuration (or the variant) and returns a searcher. Each search loads the index its
 * chunker and embedder name, builds the retrievers the config asks for over it, runs the question
 * and reports what every retriever found. The question is embedded with the model recorded in the
 * index's manifest, so it always matches the vectors it is compared with.
 */
export async function buildSearcher(options: BuildSearcherOptions = {}): Promise<Searcher> {
  const {
    argv = process.argv.slice(2),
    env = process.env,
    cacheDir = DEFAULT_EMBEDDING_CACHE_DIR,
    logger = createConsoleLogger(),
  } = options;

  const configArgv =
    options.variant === undefined
      ? argv
      : [
          "--config",
          await resolveVariant(options.variant, options.variantsDir ?? DEFAULT_VARIANTS_DIR),
          ...argv,
        ];
  const config = await loadConfig({ argv: configArgv, env });
  const reader = new FileIndexReader(options.indexDir ?? config.vectorStore.dir);

  return {
    async search(question, searchOptions = {}) {
      const k = searchOptions.k ?? config.retrieval.k;
      if (!Number.isInteger(k) || k < 1) {
        throw new RagError(
          "INVALID_ARGUMENT",
          `k must be a whole number of 1 or more, got ${String(k)}`,
        );
      }
      const filter = searchOptions.filter ?? [];
      const chunker = searchOptions.chunker ?? config.chunking.strategy;
      const embedderSpec =
        searchOptions.embedder ?? `${config.embedding.provider}:${config.embedding.model}`;

      const index = await openIndex(
        reader,
        indexNamespace(chunker, embedderSpec),
        config.vectorStore,
        logger,
      );

      const embedder = usesEmbedder(config.retrieval.strategy)
        ? buildEmbedder(index.manifest.embedder.modelId, {
            batchSize: index.manifest.embedder.batchSize,
            env,
            cacheDir,
            logger,
            ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
          })
        : undefined;

      const started = performance.now();
      const trace = new Trace();
      const found: { name: string; results: readonly RetrievedChunk[] }[] = [];
      const base = buildRetriever(config.retrieval, {
        index,
        ...(embedder === undefined ? {} : { embedder }),
        wrap: (inner) =>
          new ObservedRetriever(inner, trace, (name, results) => {
            found.push({ name, results });
          }),
      });
      // Watches what the reranker is given. Its trace is thrown away: the stages shown in the report
      // are the base retrievers', and this one is not a retriever of its own.
      let candidates: readonly RetrievedChunk[] = [];
      const reranked = new ObservedRetriever(base, new Trace(), (_name, results) => {
        candidates = results;
      });
      const retriever = buildRerankingRetriever(reranked, config.rerank, {
        generation: config.generation,
        env,
        logger,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      });

      const results = await retriever.retrieve({ text: question }, { k, filter });
      const totalMs = performance.now() - started;
      const { stages } = trace.snapshot();

      const { manifest } = index;
      return {
        question,
        k,
        filter,
        settings: {
          strategy: config.retrieval.strategy,
          fusion: config.retrieval.fusion,
          rerank: { enabled: config.rerank.enabled, strategy: config.rerank.strategy },
        },
        index: {
          namespace: index.namespace,
          location: index.location,
          embedder: manifest.embedder.modelId,
          chunker: manifest.chunker.name,
          chunks: manifest.counts.chunks,
          vectors: manifest.counts.vectors,
          parents: manifest.counts.parents,
          gitCommit: manifest.gitCommit,
          createdAt: manifest.createdAt,
          loadMs: index.loadMs,
        },
        retrievers: found.map(({ name, results: own }) => {
          const stage = stages.find((s) => s.stage === name && s.status === "ok");
          return {
            name,
            startMs: Math.round(stage?.startMs ?? 0),
            durationMs: Math.round(stage?.durationMs ?? 0),
            results: own,
          };
        }),
        retriever: retriever.name,
        candidates,
        results,
        totalMs: Math.round(totalMs),
        stages,
      };
    },
  };
}

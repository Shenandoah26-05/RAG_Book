import { readFile } from "node:fs/promises";
import path from "node:path";
import { FileIndexReader } from "../adapters/index.js";
import { loadConfig } from "../config/index.js";
import type { Env, RagConfig } from "../config/index.js";
import type { Embedder, LlmProvider, PromptTemplate } from "../core/index.js";
import { GroundedPipeline, indexNamespace, RagPipeline } from "../pipeline/index.js";
import { createConsoleLogger, RagError } from "../shared/index.js";
import type { Logger } from "../shared/index.js";
import {
  isOrderingName,
  ORDERING_NAMES,
  parsePromptTemplate,
  TemplateContextAssembler,
} from "../strategies/index.js";
import { buildChunkerRegistry } from "./build-chunkers.js";
import { buildEmbedder, DEFAULT_EMBEDDING_CACHE_DIR } from "./build-embedder.js";
import { buildLlmProvider } from "./build-llm-provider.js";
import { Resilience } from "./build-resilience.js";
import { buildQueryTransformer, withVariantSearch } from "./build-query-transformer.js";
import { resolveRerank } from "./build-reranker.js";
import { buildRetriever } from "./build-retriever.js";
import { buildChunker } from "./chunker-registry.js";
import { openIndex } from "./load-index.js";
import { buildTokenizer } from "./registries.js";
import { argvWithVariant } from "./variants.js";

/** The prompt the pipeline answers with. A new wording is a new file and a change here. */
export const PROMPT_FILE = "rag-system.v2.txt";
/** Where prompt files are read from unless told otherwise. */
export const DEFAULT_PROMPTS_DIR = "prompts";

export interface BuildPipelineOptions {
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
  /** Where prompt files are. Default `prompts`. */
  readonly promptsDir?: string;
  readonly logger?: Logger;
  readonly fetch?: typeof fetch;
  /** Use this embedder instead of the one in the config. For tests. */
  readonly embedder?: Embedder;
  /** Use this model instead of the one in the config. For tests. */
  readonly llm?: LlmProvider;
}

async function readPrompt(dir: string): Promise<PromptTemplate> {
  const file = path.join(dir, PROMPT_FILE);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (cause) {
    throw new RagError("CONFIG_INVALID", `Cannot read the prompt file ${file}`, { cause });
  }
  return parsePromptTemplate(PROMPT_FILE, text);
}

/**
 * Builds the whole question-answering pipeline from the configuration. This file and the stage
 * builders it calls are the only place that knows which concrete class does each job; the
 * `RagPipeline` it returns knows only ports. It is also the only code that constructs a
 * `RagPipeline`.
 *
 *   config --> embedder, index --> retriever
 *          --> reranker (the no-op one when rerank.enabled is false)
 *          --> tokenizer + prompt file --> assembler
 *          --> language model
 *
 * The index it loads is the one built by `pnpm index` for the configured chunker and embedder.
 * Nothing is sent over the network until a question is asked.
 *
 * @throws ConfigError for a bad config; CONFIG_INVALID for an unknown name or an unreadable prompt;
 *   INVALID_ARGUMENT if there is no index yet; INDEX_CORRUPT if the saved index is damaged
 */
export async function buildPipeline(options: BuildPipelineOptions = {}): Promise<GroundedPipeline> {
  return (await buildPipelineWithConfig(options)).pipeline;
}

/** A pipeline together with the configuration it was built from and the index it answers from. */
export interface BuiltPipeline {
  readonly pipeline: GroundedPipeline;
  /** The effective configuration: defaults, file or variant, environment and command line. */
  readonly config: RagConfig;
  /** The folder name of the index in use, `<chunker>__<embedder>`. */
  readonly namespace: string;
}

/**
 * `buildPipeline`, for callers that also need to show what was built (the chatbot's `/config`).
 * The configuration is read once, so what is shown is what the pipeline was built from.
 */
export async function buildPipelineWithConfig(
  options: BuildPipelineOptions = {},
): Promise<BuiltPipeline> {
  const {
    argv = process.argv.slice(2),
    env = process.env,
    cacheDir = DEFAULT_EMBEDDING_CACHE_DIR,
    promptsDir = DEFAULT_PROMPTS_DIR,
    logger = createConsoleLogger(),
  } = options;

  const config = await loadConfig({
    argv: await argvWithVariant(argv, options.variant, options.variantsDir),
    env,
  });
  // one for the run, so the answering model, the reranker and the embedder each keep to their limit
  const resilience = new Resilience(config.resilience, { logger });
  const embedder =
    options.embedder ??
    buildEmbedder(`${config.embedding.provider}:${config.embedding.model}`, {
      batchSize: config.embedding.batchSize,
      env,
      cacheDir,
      logger,
      resilience,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
  const tokenizer = buildTokenizer(config.chunking.tokenizer);

  // the index of this chunker and this embedder, found the way the indexer named it
  const chunker = buildChunker(config.chunking, buildChunkerRegistry(tokenizer));
  const namespace = indexNamespace(chunker.name, embedder.modelId);
  const reader = new FileIndexReader(options.indexDir ?? config.vectorStore.dir);
  const index = await openIndex(reader, namespace, config.vectorStore, logger);

  // no `rerank` here: the pipeline has a rerank stage of its own
  const retriever = withVariantSearch(
    buildRetriever(config.retrieval, { index, embedder }),
    config.queryTransform,
  );
  const rerank = resolveRerank(config.rerank, {
    // the "llm" reranker judges with the answering model, unless a model is given
    ...(options.llm === undefined ? { generation: config.generation } : { llm: options.llm }),
    env,
    logger,
    resilience,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });

  const { ordering } = config.generation;
  if (!isOrderingName(ordering)) {
    throw new RagError(
      "CONFIG_INVALID",
      `Unknown ordering "${ordering}" in generation.ordering. Known orderings: ${ORDERING_NAMES.join(", ")}`,
    );
  }
  const assembler = new TemplateContextAssembler({
    tokenizer,
    template: await readPrompt(promptsDir),
    budgetTokens: config.generation.contextBudgetTokens,
    ordering,
  });

  const llm =
    options.llm ??
    buildLlmProvider(config.generation, {
      env,
      resilience,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });

  const pipeline = new RagPipeline({
    // rewriting and HyDE use the answering model, like the "llm" reranker
    transformer: await buildQueryTransformer(config.queryTransform, { llm, promptsDir }),
    retriever,
    reranker: rerank.reranker,
    rerankCandidates: rerank.candidates,
    assembler,
    llm,
    k: config.retrieval.k,
  });
  // the guardrails wrap the finished pipeline; the pipeline itself knows nothing about them
  const grounded = new GroundedPipeline({ inner: pipeline, minScore: config.grounding.minScore });
  return { pipeline: grounded, config, namespace };
}

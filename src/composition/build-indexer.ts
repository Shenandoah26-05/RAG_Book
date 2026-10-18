import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { FileDocumentStore, FileIndexWriter } from "../adapters/index.js";
import { hashConfig, loadConfig } from "../config/index.js";
import type { Env, RagConfig } from "../config/index.js";
import type { DocId } from "../core/index.js";
import { buildIndex, indexNamespace } from "../pipeline/index.js";
import type { IndexResult } from "../pipeline/index.js";
import { createConsoleLogger, RagError } from "../shared/index.js";
import type { Logger } from "../shared/index.js";
import { FlatVectorStore, InMemoryChunkStore } from "../strategies/index.js";
import { buildChunkerRegistry } from "./build-chunkers.js";
import { buildEmbedder, DEFAULT_EMBEDDING_CACHE_DIR } from "./build-embedder.js";
import { DEFAULT_PROCESSED_DIR } from "./build-ingest.js";
import { buildChunker } from "./chunker-registry.js";
import { buildTokenizer } from "./registries.js";
import { resolveDocId } from "./resolve-doc-id.js";

export interface BuildIndexerOptions {
  readonly argv?: readonly string[];
  readonly env?: Env;
  /** Where processed documents are read from. Default `data/processed`. */
  readonly processedDir?: string;
  /** Where indexes go. Default `vectorStore.dir` from the config (`data/index`). */
  readonly indexDir?: string;
  /** Where embedding vectors are cached. Default `data/cache/embeddings`. */
  readonly cacheDir?: string;
  readonly logger?: Logger;
  readonly fetch?: typeof fetch;
  /** The commit to record. Default: `git rev-parse HEAD`, or null outside a repository. */
  readonly gitCommit?: string | null;
}

export interface IndexRunOptions {
  /** Chunking strategy. Default: `chunking.strategy` from the config. */
  readonly chunker?: string;
  /** Embedder as `provider:model`. Default: `embedding.provider` and `embedding.model`. */
  readonly embedder?: string;
  /** Documents (ids or PDF paths). Default: every document in the processed folder. */
  readonly targets?: readonly string[];
  readonly force?: boolean;
}

export interface Indexer {
  run(options?: IndexRunOptions): Promise<IndexResult>;
}

async function currentGitCommit(): Promise<string | null> {
  try {
    const { stdout } = await promisify(execFile)("git", ["rev-parse", "HEAD"]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Reads the configuration and wires the indexing pipeline: the chunker and embedder (from the
 * options, else the config), fresh in-memory stores, and the writer for `<indexDir>/<namespace>/`.
 * Throws a ConfigError for a bad config and CONFIG_INVALID for an unknown chunker or embedder.
 */
export async function buildIndexer(options: BuildIndexerOptions = {}): Promise<Indexer> {
  const {
    argv = process.argv.slice(2),
    env = process.env,
    processedDir = DEFAULT_PROCESSED_DIR,
    cacheDir = DEFAULT_EMBEDDING_CACHE_DIR,
    logger = createConsoleLogger(),
  } = options;

  const config = await loadConfig({ argv, env });
  const indexDir = options.indexDir ?? config.vectorStore.dir;
  const tokenizer = buildTokenizer(config.chunking.tokenizer);
  const registry = buildChunkerRegistry(tokenizer);
  const documents = new FileDocumentStore(processedDir);

  return {
    async run(runOptions = {}) {
      const strategy = runOptions.chunker ?? config.chunking.strategy;
      const embedderSpec =
        runOptions.embedder ?? `${config.embedding.provider}:${config.embedding.model}`;
      // built first, so a wrong name is reported before any file is read
      const chunker = buildChunker({ ...config.chunking, strategy }, registry);
      const embedder = buildEmbedder(embedderSpec, {
        batchSize: config.embedding.batchSize,
        env,
        cacheDir,
        logger,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      });

      const targets = runOptions.targets ?? [];
      const docIds: readonly DocId[] =
        targets.length > 0 ? await Promise.all(targets.map(resolveDocId)) : await documents.list();
      if (docIds.length === 0) {
        throw new RagError(
          "INVALID_ARGUMENT",
          `No processed documents in ${processedDir}. Run "pnpm ingest <file.pdf>" first.`,
        );
      }

      // the hash describes what was really built, so it includes the command-line choices
      const effective: RagConfig = {
        ...config,
        chunking: { ...config.chunking, strategy },
        embedding: {
          ...config.embedding,
          provider: embedderSpec.slice(0, embedderSpec.indexOf(":")),
          model: embedderSpec.slice(embedderSpec.indexOf(":") + 1),
        },
      };

      return buildIndex(
        {
          documents,
          chunker,
          embedder,
          vectorStore: new FlatVectorStore(embedder.dimensions),
          chunkStore: new InMemoryChunkStore(),
          writer: new FileIndexWriter(indexDir),
          logger,
        },
        docIds,
        {
          namespace: indexNamespace(chunker.name, embedder.modelId),
          chunker: {
            name: chunker.name,
            tokenizer: config.chunking.tokenizer,
            maxTokens: config.chunking.maxTokens,
            overlapTokens: config.chunking.overlapTokens,
          },
          batchSize: config.embedding.batchSize,
          configHash: hashConfig(effective),
          gitCommit: options.gitCommit === undefined ? await currentGitCommit() : options.gitCommit,
        },
        { force: runOptions.force === true },
      );
    },
  };
}

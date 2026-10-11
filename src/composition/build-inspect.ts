import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { FileDocumentStore } from "../adapters/index.js";
import { loadConfig } from "../config/index.js";
import type { Env } from "../config/index.js";
import type { Chunk, DocId } from "../core/index.js";
import { isDocId, makeDocId, RagError, sha256OfFile } from "../shared/index.js";
import { renderChunkReport, sampleChunks, seedFrom, summarizeChunks } from "../strategies/index.js";
import type { ChunkStats } from "../strategies/index.js";
import { buildChunkerRegistry } from "./build-chunkers.js";
import { buildChunker } from "./chunker-registry.js";
import { DEFAULT_PROCESSED_DIR } from "./build-ingest.js";
import { buildTokenizer } from "./registries.js";

/** How many chunks are shown as samples unless told otherwise. */
export const DEFAULT_SAMPLES = 3;

export interface BuildInspectOptions {
  readonly argv?: readonly string[];
  readonly env?: Env;
  /** Where processed documents are read from, and the report is written. Default `data/processed`. */
  readonly processedDir?: string;
}

export interface InspectOptions {
  /** The chunking strategy to look at. Default: `chunking.strategy` from the config. */
  readonly strategy?: string;
  /** How many random chunks to show. Default 3. */
  readonly samples?: number;
  /** Seed for the random pick. Default: worked out from the document and strategy, so it repeats. */
  readonly seed?: number;
}

export interface InspectResult {
  readonly docId: DocId;
  readonly title: string;
  readonly strategy: string;
  readonly stats: ChunkStats;
  readonly samples: readonly Chunk[];
  /** The markdown file with every chunk. */
  readonly reportPath: string;
}

export interface Inspector {
  /**
   * Chunks a processed document with one strategy and writes a report to read. `target` is a
   * document id, or the path of the PDF that was ingested (its id is worked out from its contents).
   */
  run(target: string, options?: InspectOptions): Promise<InspectResult>;
}

async function isFile(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

/** The document id for what the user typed: an id as it is, a PDF by the hash of its contents. */
async function resolveDocId(target: string): Promise<DocId> {
  if (isDocId(target)) return target;
  if (await isFile(target)) return makeDocId(await sha256OfFile(target));
  throw new RagError(
    "INVALID_ARGUMENT",
    `"${target}" is neither a document id nor an existing file`,
  );
}

/**
 * Reads the configuration and wires the chunk inspector: the chunking strategies, the tokenizer
 * named in `chunking.tokenizer`, and the store the documents were ingested into. Throws a
 * ConfigError for a bad config.
 */
export async function buildInspect(options: BuildInspectOptions = {}): Promise<Inspector> {
  const {
    argv = process.argv.slice(2),
    env = process.env,
    processedDir = DEFAULT_PROCESSED_DIR,
  } = options;

  const config = await loadConfig({ argv, env });
  const tokenizer = buildTokenizer(config.chunking.tokenizer);
  const registry = buildChunkerRegistry(tokenizer);
  const store = new FileDocumentStore(processedDir);

  return {
    async run(target, inspectOptions = {}) {
      const strategy = inspectOptions.strategy ?? config.chunking.strategy;
      // built first, so an unknown strategy is reported before any file is read
      const chunker = buildChunker({ ...config.chunking, strategy }, registry);

      const docId = await resolveDocId(target);
      const doc = await store.load(docId);
      if (doc === undefined) {
        throw new RagError(
          "INVALID_ARGUMENT",
          `No processed document ${docId} in ${processedDir}. Run "pnpm ingest <file.pdf>" first.`,
        );
      }

      const chunks = await chunker.chunk(doc);
      const stats = summarizeChunks(chunks, (text) => tokenizer.count(text));
      const samples = sampleChunks(
        chunks,
        inspectOptions.samples ?? DEFAULT_SAMPLES,
        inspectOptions.seed ?? seedFrom(`${docId}|${strategy}`),
      );

      const reportPath = path.join(processedDir, `${docId}.${strategy}.chunks.md`);
      await mkdir(processedDir, { recursive: true });
      await writeFile(
        reportPath,
        renderChunkReport({
          docId,
          title: doc.title,
          strategy,
          tokenizer: config.chunking.tokenizer,
          maxTokens: config.chunking.maxTokens,
          overlapTokens: config.chunking.overlapTokens,
          stats,
          chunks,
        }),
        "utf8",
      );

      return { docId, title: doc.title, strategy, stats, samples, reportPath };
    },
  };
}

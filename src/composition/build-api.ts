import { DirectorySourceFileStore, FileDocumentStore } from "../adapters/index.js";
import type { ChunkStore, DocId, DocumentStore, SourceFileStore } from "../core/index.js";
import type { GroundedPipeline } from "../pipeline/index.js";
import type { PriceTable } from "../shared/index.js";
import { DEFAULT_PROCESSED_DIR } from "./build-ingest.js";
import { buildPipelineWithConfig } from "./build-pipeline.js";
import type { BuildPipelineOptions } from "./build-pipeline.js";

/** Where `pnpm ingest` is usually pointed: the folder the reader looks in for the source PDF. */
export const DEFAULT_RAW_DIR = "data/raw";

/**
 * What the HTTP API needs, and nothing more: the pipeline to ask, the stores to read pages and
 * chunks from, and the prices to put on an answer. The API (`src/api/`) holds no pipeline logic;
 * everything it does it does through these.
 */
export interface ApiServices {
  readonly pipeline: Pick<GroundedPipeline, "ask">;
  /** Reads the processed book, for `GET /pages/:n`. */
  readonly documents: Pick<DocumentStore, "load">;
  /** Reads a chunk of the index, for `GET /chunks/:id`. */
  readonly chunks: Pick<ChunkStore, "get">;
  /** Finds the PDF a document was made from, for the reader (`GET /book/pdf`). */
  readonly sources: SourceFileStore;
  /** The documents the index holds, which are the ones the answers (and so the pages) come from. */
  readonly documentIds: readonly DocId[];
  /** What the models cost, to put money on an answer. */
  readonly prices: PriceTable;
  /** The index in use, `<chunker>__<embedder>`, for the log line at start-up. */
  readonly namespace: string;
  /** The model that answers, for the log line at start-up. */
  readonly model: string;
}

export interface BuildApiOptions extends BuildPipelineOptions {
  /** Where processed documents are read from. Default `data/processed`. */
  readonly processedDir?: string;
  /** Where the source PDFs are looked for, by content hash. Default `data/raw`. */
  readonly rawDir?: string;
}

/**
 * Builds the pipeline from the configuration, as `pnpm chat` does, and the stores the API reads
 * pages and chunks from. The index is loaded once, at start: a server that finds the index missing
 * should say so when it starts and not on the first request.
 *
 * @throws as `buildPipeline` does: ConfigError for a bad config, INVALID_ARGUMENT if there is no
 *   index yet (run `pnpm index`), INDEX_CORRUPT for a damaged one
 */
export async function buildApiServices(options: BuildApiOptions = {}): Promise<ApiServices> {
  const {
    processedDir = DEFAULT_PROCESSED_DIR,
    rawDir = DEFAULT_RAW_DIR,
    ...pipelineOptions
  } = options;
  const { pipeline, config, namespace, index } = await buildPipelineWithConfig(pipelineOptions);
  return {
    pipeline,
    documents: new FileDocumentStore(processedDir),
    sources: new DirectorySourceFileStore(rawDir),
    chunks: index.chunkStore,
    documentIds: index.manifest.documents,
    prices: config.pricing,
    namespace,
    model: pipeline.describe().llm,
  };
}

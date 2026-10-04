import { FileDocumentStore } from "../adapters/index.js";
import { loadConfig } from "../config/index.js";
import type { Env } from "../config/index.js";
import { ingest } from "../pipeline/index.js";
import type { IngestOptions, IngestResult } from "../pipeline/index.js";
import { createConsoleLogger, sha256OfFile } from "../shared/index.js";
import type { Logger } from "../shared/index.js";
import { FontHeadingDetector } from "../strategies/index.js";
import { buildCleaner, buildLoader } from "./registries.js";

/** Where processed documents go unless told otherwise. */
export const DEFAULT_PROCESSED_DIR = "data/processed";

export interface BuildIngestOptions {
  readonly argv?: readonly string[];
  readonly env?: Env;
  /** Folder for processed documents. Default `data/processed`. */
  readonly outDir?: string;
  readonly logger?: Logger;
}

export interface Ingester {
  run(filePath: string, options?: IngestOptions): Promise<IngestResult>;
}

/**
 * Reads the configuration and wires the ingestion pipeline from it: the loader and the cleaning
 * chain named in `ingestion`, the heading detector, and a store in `outDir`. Throws a ConfigError
 * for a bad config, including an unknown loader or cleaner.
 */
export async function buildIngest(options: BuildIngestOptions = {}): Promise<Ingester> {
  const {
    argv = process.argv.slice(2),
    env = process.env,
    outDir = DEFAULT_PROCESSED_DIR,
    logger = createConsoleLogger(),
  } = options;

  const config = await loadConfig({ argv, env });
  const deps = {
    loader: buildLoader(config.ingestion.loader),
    cleaner: buildCleaner(config.ingestion.cleaners),
    detector: new FontHeadingDetector(),
    store: new FileDocumentStore(outDir),
    logger,
    hashFile: sha256OfFile,
  };
  return { run: (filePath, runOptions) => ingest(deps, filePath, runOptions) };
}

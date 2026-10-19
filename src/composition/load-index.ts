import type { RagConfig } from "../config/index.js";
import type {
  ChunkStore,
  IndexContents,
  IndexManifest,
  IndexReader,
  KeywordIndex,
  VectorStore,
} from "../core/index.js";
import { noopLogger, RagError } from "../shared/index.js";
import type { Logger } from "../shared/index.js";
import { Bm25Index, InMemoryChunkStore } from "../strategies/index.js";
import { buildVectorStore } from "./build-vector-store.js";

/** A saved index, loaded into stores that retrievers can search. */
export interface LoadedIndex {
  readonly manifest: IndexManifest;
  readonly vectorStore: VectorStore;
  /** Every chunk, parents included. */
  readonly chunkStore: ChunkStore;
  /** Absent when the index was saved without one. */
  readonly keywordIndex?: KeywordIndex;
  /** Whether the index holds parent chunks (the parent-child strategy), which retrieval expands to. */
  readonly hasParents: boolean;
}

/**
 * Puts what `FileIndexReader` read into the stores named in the configuration: a vector store of
 * `vectorStore.type` holding the vectors, a chunk store holding every chunk, and the keyword index
 * rebuilt from its saved text.
 * @throws RagError CONFIG_INVALID for an unknown vector store; INDEX_CORRUPT for a damaged keyword index
 */
export async function loadIndex(
  contents: IndexContents,
  settings: RagConfig["vectorStore"],
): Promise<LoadedIndex> {
  const { manifest } = contents;
  const vectorStore = buildVectorStore(settings, manifest.embedder.dimensions);
  await vectorStore.upsert(contents.vectors);
  const chunkStore = new InMemoryChunkStore();
  await chunkStore.put(contents.chunks);
  return {
    manifest,
    vectorStore,
    chunkStore,
    ...(contents.keywordIndex === undefined
      ? {}
      : { keywordIndex: Bm25Index.deserialize(contents.keywordIndex) }),
    hasParents: manifest.counts.parents > 0,
  };
}

/** An index read from disk and loaded, with where it came from and how long that took. */
export interface OpenedIndex extends LoadedIndex {
  readonly namespace: string;
  /** Where it was read from. */
  readonly location: string;
  readonly loadMs: number;
}

/**
 * Reads the index of `namespace` and loads it (see `loadIndex`): no model is called and nothing is
 * embedded again. The load time is logged.
 * @throws RagError INVALID_ARGUMENT if there is no such index (saying how to build it);
 *   INDEX_CORRUPT if it is damaged; CONFIG_INVALID as `loadIndex` does
 */
export async function openIndex(
  reader: IndexReader,
  namespace: string,
  settings: RagConfig["vectorStore"],
  logger: Logger = noopLogger,
): Promise<OpenedIndex> {
  const started = performance.now();
  const location = reader.locationOf(namespace);
  const contents = await reader.read(namespace);
  if (contents === undefined) {
    throw new RagError(
      "INVALID_ARGUMENT",
      `No index "${namespace}" in ${location}. Build it with "pnpm index" (the chunker and embedder ` +
        "come from the config, or --chunker and --embedder).",
    );
  }
  const loaded = await loadIndex(contents, settings);
  const loadMs = Math.round(performance.now() - started);
  logger.info("index loaded", {
    namespace,
    chunks: contents.chunks.length,
    vectors: contents.vectors.length,
    durationMs: loadMs,
  });
  return { ...loaded, namespace, location, loadMs };
}

import type { RagConfig } from "../config/index.js";
import type {
  ChunkStore,
  IndexContents,
  IndexManifest,
  KeywordIndex,
  VectorStore,
} from "../core/index.js";
import { Bm25Index, InMemoryChunkStore } from "../strategies/index.js";
import { buildVectorStore } from "./build-vector-store.js";

/** A saved index, loaded into stores that retrievers can search. */
export interface LoadedIndex {
import type {
  ChunkStore,
  IndexManifest,
  IndexReader,
  KeywordIndex,
  VectorStore,
} from "../core/index.js";
import { RagError, noopLogger } from "../shared/index.js";
import type { Logger } from "../shared/index.js";
import { Bm25Index, FlatVectorStore, InMemoryChunkStore } from "../strategies/index.js";

/** An index read back from disk and put into the stores a retriever searches. */
export interface LoadedIndex {
  readonly namespace: string;
  /** Where it was read from. */
  readonly location: string;
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
  /** Absent if the index was built without one. */
  readonly keywordIndex?: KeywordIndex;
  readonly loadMs: number;
}

/**
 * Reads the index of `namespace` and fills in-memory stores from it: no model is called and nothing
 * is embedded again. The load time is logged.
 * @throws RagError INVALID_ARGUMENT if there is no such index (saying how to build it),
 *   INDEX_CORRUPT if it is damaged
 */
export async function loadIndex(
  reader: IndexReader,
  namespace: string,
  logger: Logger = noopLogger,
): Promise<LoadedIndex> {
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

  const vectorStore = new FlatVectorStore(contents.manifest.embedder.dimensions);
  await vectorStore.upsert(contents.vectors);
  const chunkStore = new InMemoryChunkStore();
  await chunkStore.put(contents.chunks);
  const keywordIndex =
    contents.keywordIndex === undefined ? undefined : Bm25Index.deserialize(contents.keywordIndex);

  const loadMs = Math.round(performance.now() - started);
  logger.info("index loaded", {
    namespace,
    chunks: contents.chunks.length,
    vectors: contents.vectors.length,
    durationMs: loadMs,
  });
  return {
    namespace,
    location,
    manifest: contents.manifest,
    vectorStore,
    chunkStore,
    ...(keywordIndex === undefined ? {} : { keywordIndex }),
    loadMs,
  };
}

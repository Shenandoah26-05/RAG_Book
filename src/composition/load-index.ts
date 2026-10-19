import type { RagConfig } from "../config/index.js";
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
import { buildVectorStore } from "./build-vector-store.js";

/** An index read back from disk and put into the stores a retriever searches. */
export interface LoadedIndex {
  readonly namespace: string;
  /** Where it was read from. */
  readonly location: string;
  readonly manifest: IndexManifest;
  readonly vectorStore: VectorStore;
  /** Every chunk, parents included. */
  readonly chunkStore: ChunkStore;
  /** Absent if the index was built without one. */
  readonly keywordIndex?: KeywordIndex;
  readonly loadMs: number;
}

/**
 * Reads the index of `namespace` and fills stores from it: no model is called and nothing is
 * embedded again. The load time is logged.
 *
 * The chunks and the keyword index are always held in memory. The vectors go into a flat in-memory
 * store, or, when `vectorStore` (the `vectorStore.*` settings) is given, into the store of that type.
 * @throws RagError INVALID_ARGUMENT if there is no such index (saying how to build it),
 *   INDEX_CORRUPT if it is damaged, CONFIG_INVALID for an unknown vector store type
 */
export async function loadIndex(
  reader: IndexReader,
  namespace: string,
  logger: Logger = noopLogger,
  vectorStore?: RagConfig["vectorStore"],
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

  const { dimensions } = contents.manifest.embedder;
  const vectors =
    vectorStore === undefined
      ? new FlatVectorStore(dimensions)
      : buildVectorStore(vectorStore, dimensions);
  await vectors.upsert(contents.vectors);
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
    vectorStore: vectors,
    chunkStore,
    ...(keywordIndex === undefined ? {} : { keywordIndex }),
    loadMs,
  };
}

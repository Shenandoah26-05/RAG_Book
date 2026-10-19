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

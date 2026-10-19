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

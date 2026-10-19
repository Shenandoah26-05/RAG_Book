import type { Chunk } from "../types/chunk.js";
import type { IndexManifest } from "../types/index-manifest.js";
import type { VectorRecord } from "../types/retrieval.js";

/** Everything an index consists of. */
export interface IndexContents {
  readonly manifest: IndexManifest;
  /** One vector per searchable chunk. */
  readonly vectors: readonly VectorRecord[];
  /** Every chunk, in order. Chunks without a vector in `vectors` are stored but not searched. */
  readonly chunks: readonly Chunk[];
  /** The keyword index (`KeywordIndex.serialize()`), saved in the same folder. Absent: none. */
  readonly keywordIndex?: string;
}

/**
 * Saves a finished index under its namespace, and reads back the manifest of an earlier one.
 *
 * Rules every writer must follow:
 * 1. `write` replaces any earlier index in the namespace completely, and is all or nothing: a crash
 *    leaves either the old index or the new one, never a mix.
 * 2. `readManifest` returns undefined if there is no complete index, and rejects if the manifest is
 *    damaged or from another version of the format.
 * 3. A namespace is a plain folder-style name; anything that could leave the index folder is
 *    INVALID_ARGUMENT.
 * 4. A keyword index is saved with the rest, so it is complete or absent together with them.
 *    `readKeywordIndex` returns its text, or undefined if this index has none.
 */
export interface IndexWriter {
  readManifest(namespace: string): Promise<IndexManifest | undefined>;
  /** The saved keyword index of this namespace, or undefined if there is none. */
  readKeywordIndex(namespace: string): Promise<string | undefined>;
  /** Saves the index. Returns where it went. */
  write(contents: IndexContents): Promise<string>;
  /** Where the index of this namespace is, or would be. For messages. */
  locationOf(namespace: string): string;
}

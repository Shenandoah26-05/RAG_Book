import type { IndexContents } from "./index-writer.js";

/**
 * Reads back an index that an `IndexWriter` saved: the other half of the pair. What it returns is
 * what was written (`IndexContents`), so a retriever can be built from it without re-embedding.
 *
 * Rules every reader must follow:
 * 1. `read` returns undefined if there is no complete index in the namespace.
 * 2. A damaged index is a RagError coded INDEX_CORRUPT that says what is wrong and how to rebuild
 *    it: a file that cannot be parsed, a file whose size does not match the counts in the manifest,
 *    or a vector that does not belong to a chunk. It never returns half an index.
 * 3. A namespace is a plain folder-style name; anything that could leave the index folder is
 *    INVALID_ARGUMENT.
 */
export interface IndexReader {
  read(namespace: string): Promise<IndexContents | undefined>;
  /** Where the index of this namespace is, or would be. For messages. */
  locationOf(namespace: string): string;
}

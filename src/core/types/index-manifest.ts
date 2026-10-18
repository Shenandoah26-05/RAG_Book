import type { DocId } from "./ids.js";

/** Bump when the shape of `manifest.json` changes, so an old index is rebuilt instead of misread. */
export const INDEX_MANIFEST_VERSION = 1;

/**
 * Describes one built index: what it was built from, with which settings, and how long it took.
 * It is written next to the index as `manifest.json`, so any later number (a retrieval score, an
 * answer) can be traced to the exact artifact and the code that made it.
 */
export interface IndexManifest {
  readonly version: typeof INDEX_MANIFEST_VERSION;
  /** Folder name of the index: `<chunker>__<embedder>`. */
  readonly namespace: string;
  /** ISO 8601 time the build finished. */
  readonly createdAt: string;
  /** `git rev-parse HEAD` when the index was built; null outside a git checkout. */
  readonly gitCommit: string | null;
  /** SHA-256 of the whole configuration (`hashConfig`), the same tag experiment results carry. */
  readonly configHash: string;
  /**
   * SHA-256 of only what shapes this index: the chunker, the embedder and the document ids. If it
   * has not changed, rebuilding would give the same index, so the build is skipped.
   */
  readonly fingerprint: string;
  readonly chunker: {
    readonly name: string;
    readonly tokenizer: string;
    readonly maxTokens: number;
    readonly overlapTokens: number;
  };
  readonly embedder: {
    readonly modelId: string;
    readonly dimensions: number;
    readonly batchSize: number;
  };
  /** The documents in the index, sorted. */
  readonly documents: readonly DocId[];
  readonly counts: {
    readonly documents: number;
    /** Every chunk stored, parents included. */
    readonly chunks: number;
    /** Chunks stored but not indexed (the parents of the parent-child strategy). */
    readonly parents: number;
    /** Vectors in the index: the chunks that can be found by search. */
    readonly vectors: number;
  };
  /** Milliseconds per step: `chunk`, `embed`, `store`, `write`, and `total`. */
  readonly timingsMs: Readonly<Record<string, number>>;
}

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------------------------
// Branded ids
// ---------------------------------------------------------------------------------------------

/**
 * A string that the compiler treats as its own type. A `ChunkId` cannot be passed where a `DocId`
 * is expected, even though both are strings at runtime. The brand exists only in the type system.
 */
export type Brand<T, B extends string> = T & { readonly __brand: B };

/**
 * Identifies a document. A UUID derived from the document's file. Core only defines the type;
 * `makeDocId` and `isDocId` live in `shared/doc-id.ts`, because they use the `uuid` package and
 * core imports no third-party packages (ADR-0001).
 */
export type DocId = Brand<string, "DocId">;

/** Identifies a chunk. A SHA-256 hash of what makes the chunk what it is, see `makeChunkId`. */
export type ChunkId = Brand<string, "ChunkId">;

// ---------------------------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------------------------

/**
 * SHA-256 (hex) of the given parts. Each part is length-prefixed before hashing, so the boundaries
 * between parts matter: ("ab", "c") and ("a", "bc") produce different hashes.
 */
export function contentHash(...parts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(`${part.length.toString()}:${part}|`);
  }
  return hash.digest("hex");
}

// ---------------------------------------------------------------------------------------------
// Chunk ids
// ---------------------------------------------------------------------------------------------

export interface ChunkIdParts {
  readonly docId: DocId;
  readonly strategy: string;
  readonly charStart: number;
  readonly charEnd: number;
  readonly text: string;
}

/**
 * Id of a chunk: stable for the same document, strategy, span and text. Changing any of them (for
 * example a different chunk size) yields a different id, so indexes built by different strategies
 * never collide.
 */
export function makeChunkId(parts: ChunkIdParts): ChunkId {
  return contentHash(
    "chunk",
    parts.docId,
    parts.strategy,
    parts.charStart.toString(),
    parts.charEnd.toString(),
    parts.text,
  ) as ChunkId;
}

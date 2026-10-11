import type { Chunk } from "../types/chunk.js";
import type { ParsedDocument } from "../types/document.js";

/**
 * Splits a document into chunks, the passages that get searched and cited. There is one
 * implementation per strategy (fixed-size, recursive, structure-aware, ...), chosen by name in
 * config. See ADR-0003 and docs/design/rag-020-chunker-port.md.
 *
 * A chunker only decides WHERE chunks start and end, and which text each one keeps. Build every
 * chunk with `createChunk` (strategies/chunking), which works out the page range, the section path
 * and the id, so no chunker can get them subtly wrong.
 *
 * Rules every chunker must follow. The shared contract test checks all of them:
 * 1. The span `[charStart, charEnd)` is the passage the chunk came from. `text` may differ from that
 *    passage only in whitespace (trimmed, or runs of whitespace collapsed). Anything that must find
 *    a chunk in the document, such as highlighting a citation, uses the span, never the text.
 * 2. Chunks are in document order: starts never go back and ends strictly increase.
 * 3. Every character that is not whitespace is inside some chunk's span. Dropping text would hide
 *    it from retrieval for good.
 * 4. Chunks may overlap, but the text between two chunks may only be whitespace (no gaps).
 * 5. `docId`, `strategy` (equal to `name`) and ids are correct, and ids are unique.
 * 6. The same document gives the same chunks, and the document is not modified.
 * 7. A document with no text gives no chunks.
 */
export interface Chunker {
  /** The name used in config, e.g. "fixed-size". It is also written to `metadata.strategy`. */
  readonly name: string;
  /** The chunks of the document, in document order. Async because some strategies call a model. */
  chunk(doc: ParsedDocument): Promise<readonly Chunk[]>;
}

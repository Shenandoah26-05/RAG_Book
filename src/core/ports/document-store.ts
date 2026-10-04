import type { DocId } from "../types/ids.js";
import type { ParsedDocument } from "../types/document.js";

/**
 * Keeps processed documents between runs, so a PDF is read, cleaned and analysed once and every
 * later step starts from the saved result. Documents are stored under their id, which comes from
 * the hash of the source file.
 */
export interface DocumentStore {
  /** Whether a processed document with this id is stored. */
  has(id: DocId): Promise<boolean>;
  /** The stored document, or undefined if there is none. Rejects if the stored data is damaged. */
  load(id: DocId): Promise<ParsedDocument | undefined>;
  /** Stores the document, replacing any earlier one with the same id. Returns where it went. */
  save(doc: ParsedDocument): Promise<string>;
  /** Where the document with this id is, or would be, stored. For messages. */
  locationOf(id: DocId): string;
}

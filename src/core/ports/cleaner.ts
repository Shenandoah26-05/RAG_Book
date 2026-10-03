import type { ParsedDocument } from "../types/document.js";

/**
 * One step of the text cleaning chain: takes a document and returns a cleaner one. Each cleaner is
 * pure and does one job; the order they run in comes from config.
 *
 * Rules every cleaner must follow:
 * - Return a new document, never modify the one given. Returning the same object when there is
 *   nothing to change is fine, and makes "did anything change?" a cheap check.
 * - Keep the document consistent: every page, item and span must still index into `text`.
 * - Run before section detection. Sections hold spans, and cleaners do not move them.
 */
export interface Cleaner {
  /** The name used in config, e.g. "dehyphenate". */
  readonly name: string;
  clean(doc: ParsedDocument): ParsedDocument;
}

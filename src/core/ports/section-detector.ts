import type { ParsedDocument } from "../types/document.js";

/**
 * Recovers a document's structure: chapters, sections, subsections. Returns the document with
 * `sections` filled in and everything else unchanged. Run it after the cleaning chain, so running
 * headers and page numbers are not mistaken for headings.
 */
export interface SectionDetector {
  /** The name used in config, e.g. "font-size". */
  readonly name: string;
  detect(doc: ParsedDocument): ParsedDocument;
}

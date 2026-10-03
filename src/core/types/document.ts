import type { DocId } from "./ids.js";

/**
 * A half-open range of characters `[start, end)` in `ParsedDocument.text`.
 * Spans are what let evaluation score any chunker fairly, and let the UI highlight cited text.
 */
export interface CharSpan {
  readonly start: number;
  readonly end: number;
}

export interface Page {
  /** 1-based, as printed in the book's PDF viewer. */
  readonly number: number;
  readonly text: string;
  /** Where this page's text sits inside `ParsedDocument.text`. */
  readonly span: CharSpan;
}

/** A node in the document's heading tree. */
export interface Section {
  readonly title: string;
  /** 1 for a chapter, 2 for a subsection, and so on. */
  readonly level: number;
  readonly pageStart: number;
  readonly pageEnd: number;
  readonly span: CharSpan;
  readonly children: readonly Section[];
}

export interface ParsedDocument {
  readonly id: DocId;
  readonly title: string;
  readonly pageCount: number;
  /** SHA-256 (hex) of the source file. */
  readonly sha256: string;
  /**
   * The full cleaned text. Invariant: `text.slice(page.span.start, page.span.end) === page.text`
   * for every page, and every span in the document indexes into this string.
   */
  readonly text: string;
  readonly pages: readonly Page[];
  /** Top-level sections; deeper ones are in `children`. Empty when no structure was detected. */
  readonly sections: readonly Section[];
}

import type { DocId } from "./ids.js";

/** Pages are joined with this in `ParsedDocument.text`, so no span ever crosses a page boundary. */
export const PAGE_SEPARATOR = "\n\n";

/**
 * A half-open range of characters `[start, end)` in `ParsedDocument.text`.
 * Spans are what let evaluation score any chunker fairly, and let the UI highlight cited text.
 */
export interface CharSpan {
  readonly start: number;
  readonly end: number;
}

/**
 * A fragment of text as the PDF stores it: a run of characters in one font at one position. Books
 * are not stored as paragraphs, and heading detection needs the font size and weight.
 */
export interface TextItem {
  readonly text: string;
  /** Position of the start of the text, in PDF points from the bottom-left corner of the page. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly fontSize: number;
  /** The font's own name, e.g. "Times-Bold". */
  readonly fontName: string;
  readonly isBold: boolean;
  /** Where `text` sits inside `ParsedDocument.text`. */
  readonly span: CharSpan;
}

export interface Page {
  /** 1-based, as printed in the book's PDF viewer. */
  readonly number: number;
  readonly text: string;
  /** Where this page's text sits inside `ParsedDocument.text`. */
  readonly span: CharSpan;
  /** The text items the page was built from, in reading order. Empty if the loader has none. */
  readonly items: readonly TextItem[];
}

/** A node in the document's heading tree. */
export interface Section {
  readonly title: string;
  /** 1 for a chapter, 2 for a subsection, and so on: the depth in the tree. */
  readonly level: number;
  /** 1-based, inclusive page range of the whole section, subsections included. */
  readonly pageStart: number;
  readonly pageEnd: number;
  /** The heading and everything under it, up to the next heading of the same or a higher level. */
  readonly span: CharSpan;
  /** Where the heading text itself sits; the section's body starts after it. */
  readonly titleSpan: CharSpan;
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

// Test helpers for code that processes documents (cleaners, section detection, ...). Not part of the
// build (see tsconfig.build.json).
import { expect } from "vitest";
import { PAGE_SEPARATOR } from "../core/index.js";
import { makeDocId } from "../shared/index.js";
import type { Page, ParsedDocument, TextItem } from "../core/index.js";

export interface MakeDocumentOptions {
  /** The PDF page number of the first page. Default 1. */
  readonly firstPageNumber?: number;
  /** Font size of a line's item. Default 12. */
  readonly fontSizeOf?: (line: string) => number;
  readonly isBold?: (line: string) => boolean;
}

/**
 * Builds a consistent document from the text of each page. Every non-blank line becomes one text
 * item, so tests can check what happens to items as well as to text.
 */
export function makeDocument(
  pageTexts: readonly string[],
  options: MakeDocumentOptions = {},
): ParsedDocument {
  const { firstPageNumber = 1, fontSizeOf = () => 12, isBold = () => false } = options;

  const pages: Page[] = [];
  let offset = 0;
  pageTexts.forEach((text, index) => {
    const items: TextItem[] = [];
    let lineStart = 0;
    for (const line of text.split("\n")) {
      if (line.trim() !== "") {
        items.push({
          text: line,
          x: 72,
          y: 700 - items.length * 14,
          width: line.length * 5,
          fontSize: fontSizeOf(line),
          fontName: isBold(line) ? "Test-Bold" : "Test",
          isBold: isBold(line),
          span: { start: offset + lineStart, end: offset + lineStart + line.length },
        });
      }
      lineStart += line.length + 1;
    }
    pages.push({
      number: firstPageNumber + index,
      text,
      span: { start: offset, end: offset + text.length },
      items,
    });
    offset += text.length + PAGE_SEPARATOR.length;
  });

  return {
    id: makeDocId("test"),
    title: "Test",
    pageCount: pages.length,
    sha256: "test",
    text: pageTexts.join(PAGE_SEPARATOR),
    pages,
    sections: [],
  };
}

/** The text of each page, for comparing before and after. */
export const pageTexts = (doc: ParsedDocument): string[] => doc.pages.map((page) => page.text);

/** Asserts every span in the document still points at the right text. */
export function expectConsistent(doc: ParsedDocument): void {
  expect(doc.pageCount).toBe(doc.pages.length);
  expect(doc.text).toBe(doc.pages.map((page) => page.text).join(PAGE_SEPARATOR));
  for (const page of doc.pages) {
    expect(doc.text.slice(page.span.start, page.span.end)).toBe(page.text);
    for (const item of page.items) {
      expect(item.text).not.toBe("");
      expect(item.span.start).toBeGreaterThanOrEqual(page.span.start);
      expect(item.span.end).toBeLessThanOrEqual(page.span.end);
      expect(doc.text.slice(item.span.start, item.span.end)).toBe(item.text);
    }
  }
}

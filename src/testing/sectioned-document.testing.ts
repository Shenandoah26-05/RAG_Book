// Test helper: a small two-page document with a section tree, for chunker tests. Not part of the build.
import type { ParsedDocument, Section } from "../core/index.js";
import { makeDocument } from "./make-document.testing.js";

/**
 * A section whose span runs from `title` to the start of `nextTitle` (or the end of the text).
 * Titles are found with `indexOf`, so they must be unique in the document.
 */
export function sectionIn(
  doc: ParsedDocument,
  title: string,
  level: number,
  nextTitle: string | undefined,
  children: Section[] = [],
): Section {
  const start = doc.text.indexOf(title);
  const end = nextTitle === undefined ? doc.text.length : doc.text.indexOf(nextTitle);
  return {
    title,
    level,
    pageStart: 1,
    pageEnd: doc.pageCount,
    span: { start, end },
    titleSpan: { start, end: start + title.length },
    children,
  };
}

/**
 * Page 1: a preface, then "Chapter One". Page 2: its subsection "1.1 Sub", then "Chapter Two".
 * Word counts of the pieces: preface 2, Chapter One 5, 1.1 Sub 4, Chapter Two 4.
 */
export function makeSectionedDocument(): ParsedDocument {
  const doc = makeDocument([
    "Preface words\n\nChapter One\nalpha beta gamma",
    "1.1 Sub\ndelta epsilon\n\nChapter Two\nzeta eta",
  ]);
  return {
    ...doc,
    sections: [
      sectionIn(doc, "Chapter One", 1, "Chapter Two", [
        sectionIn(doc, "1.1 Sub", 2, "Chapter Two"),
      ]),
      sectionIn(doc, "Chapter Two", 1, undefined),
    ],
  };
}

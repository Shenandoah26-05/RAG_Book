import type { CharSpan, Chunk, ParsedDocument, Section } from "../../core/index.js";
import { makeChunkId } from "../../core/index.js";
import { RagError } from "../../shared/index.js";

// What every chunker needs and none should write for itself: turning "this span of the document"
// into a complete Chunk with correct metadata. A chunker decides where chunks start and end, and
// which text each keeps; this file works out everything else.

/** The text without any whitespace, for comparing a chunk's text with its passage. */
const withoutWhitespace = (text: string): string => text.replace(/\s+/g, "");

/**
 * The page numbers a span touches, as `{ pageStart, pageEnd }` (1-based, inclusive).
 *
 * `pageStart` is the page that contains character `start`, or the next page if `start` falls in the
 * blank line between two pages. `pageEnd` is the page that contains character `end - 1`, or the
 * previous page in that case. Pages with no text are ignored.
 */
export function pageRangeOf(
  doc: ParsedDocument,
  start: number,
  end: number,
): { readonly pageStart: number; readonly pageEnd: number } {
  const pages = doc.pages.filter((page) => page.span.end > page.span.start);
  const first = pages.find((page) => page.span.end > start) ?? pages.at(-1);
  const last = pages.findLast((page) => page.span.start < end) ?? pages[0];

  const pageStart = first?.number ?? 1;
  // a span that somehow ends before it starts, page-wise, still gets a valid range
  const pageEnd = Math.max(last?.number ?? pageStart, pageStart);
  return { pageStart, pageEnd };
}

/**
 * The titles from the chapter down to the deepest section that contains the character at
 * `position`. Empty if no section contains it, which includes a document with no sections.
 */
export function sectionPathAt(sections: readonly Section[], position: number): string[] {
  const hit = sections.find(
    (section) => section.span.start <= position && position < section.span.end,
  );
  return hit === undefined ? [] : [hit.title, ...sectionPathAt(hit.children, position)];
}

/**
 * Builds a chunk for the passage `doc.text[span.start, span.end)`.
 *
 * `text` is what the chunk keeps. By default it is the passage itself; a chunker may pass a tidied
 * version (trimmed, or with whitespace collapsed), but it may differ from the passage ONLY in
 * whitespace. Throws INVALID_ARGUMENT for a span outside the document, a span with nothing but
 * whitespace in it, or a text that changes anything other than whitespace.
 */
export function createChunk(
  doc: ParsedDocument,
  strategy: string,
  span: CharSpan,
  text?: string,
): Chunk {
  const { start, end } = span;
  const fail = (reason: string): RagError =>
    new RagError("INVALID_ARGUMENT", `createChunk (${strategy}): ${reason}`);

  const inside = Number.isInteger(start) && Number.isInteger(end);
  if (!inside || start < 0 || end > doc.text.length || start >= end) {
    throw fail(
      `span [${start.toString()}, ${end.toString()}) is not inside the document, ` +
        `which has ${doc.text.length.toString()} characters`,
    );
  }

  const passage = doc.text.slice(start, end);
  if (withoutWhitespace(passage) === "") {
    throw fail(`span [${start.toString()}, ${end.toString()}) holds only whitespace`);
  }

  const kept = text ?? passage;
  if (withoutWhitespace(kept) !== withoutWhitespace(passage)) {
    throw fail("text may differ from its passage only in whitespace");
  }

  return {
    id: makeChunkId({ docId: doc.id, strategy, charStart: start, charEnd: end, text: kept }),
    text: kept,
    metadata: {
      docId: doc.id,
      ...pageRangeOf(doc, start, end),
      sectionPath: sectionPathAt(doc.sections, start),
      charStart: start,
      charEnd: end,
      strategy,
    },
  };
}

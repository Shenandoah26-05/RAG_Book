import type { CharSpan, Page, ParsedDocument, Section } from "../../core/index.js";

const isWhitespace = (char: string | undefined): boolean => char !== undefined && /\s/.test(char);

/** The span without leading and trailing whitespace, or `undefined` if nothing else is left. */
export function trimSpan(text: string, span: CharSpan): CharSpan | undefined {
  let { start, end } = span;
  while (start < end && isWhitespace(text[start])) {
    start += 1;
  }
  while (end > start && isWhitespace(text[end - 1])) {
    end -= 1;
  }
  return start < end ? { start, end } : undefined;
}

/**
 * Cuts the document into consecutive pieces at the start and end of every section. Each piece lies
 * inside exactly one section's own text (its heading and the body before the first subsection, or
 * the body after the last one), the text before the first heading, or a gap between sections. The
 * pieces cover every non-whitespace character exactly once; whitespace at their edges is trimmed.
 * A document with no sections gives a single piece.
 */
export function sectionSegments(doc: ParsedDocument): CharSpan[] {
  const length = doc.text.length;
  const cuts = new Set<number>([0, length]);
  const visit = (sections: readonly Section[]): void => {
    for (const section of sections) {
      cuts.add(Math.min(Math.max(section.span.start, 0), length));
      cuts.add(Math.min(Math.max(section.span.end, 0), length));
      visit(section.children);
    }
  };
  visit(doc.sections);

  const sorted = [...cuts].sort((a, b) => a - b);
  const segments: CharSpan[] = [];
  for (let i = 0; i + 1 < sorted.length; i += 1) {
    const trimmed = trimSpan(doc.text, { start: sorted[i] ?? 0, end: sorted[i + 1] ?? 0 });
    if (trimmed !== undefined) {
      segments.push(trimmed);
    }
  }
  return segments;
}

/**
 * A document holding only `span`, for handing one section to another chunker. Offsets are
 * rebased so the text starts at 0; pages keep their real numbers; there are no sections. Chunks
 * the other chunker returns are shifted back by `span.start`.
 */
export function documentView(doc: ParsedDocument, span: CharSpan): ParsedDocument {
  const pages: Page[] = [];
  for (const page of doc.pages) {
    const start = Math.max(page.span.start, span.start);
    const end = Math.min(page.span.end, span.end);
    if (start >= end) {
      continue;
    }
    pages.push({
      number: page.number,
      text: doc.text.slice(start, end),
      span: { start: start - span.start, end: end - span.start },
      items: page.items
        .filter((item) => item.span.start >= start && item.span.end <= end)
        .map((item) => ({
          ...item,
          span: { start: item.span.start - span.start, end: item.span.end - span.start },
        })),
    });
  }
  return {
    ...doc,
    text: doc.text.slice(span.start, span.end),
    pageCount: pages.length,
    pages,
    sections: [],
  };
}

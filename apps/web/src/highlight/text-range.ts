/** A page's text cut into the part before a passage, the passage, and the part after. */
export interface MarkedText {
  readonly before: string;
  readonly marked: string;
  readonly after: string;
}

/**
 * The part of a page's text that lies in the passage `[from, to)` of the whole document's text.
 * `pageStart` is where the page begins in that text (the `span.start` the API gives a page), so the
 * passage is cut down to the page: a passage that began on an earlier page starts at the top of this
 * one, and one that goes on to the next ends at the bottom. A page the passage does not touch has
 * nothing marked (and is returned whole as `before`).
 */
export function markPassage(
  pageText: string,
  pageStart: number,
  from: number,
  to: number,
): MarkedText {
  const start = Math.max(from - pageStart, 0);
  const end = Math.min(to - pageStart, pageText.length);
  if (start >= end) return { before: pageText, marked: "", after: "" };
  return {
    before: pageText.slice(0, start),
    marked: pageText.slice(start, end),
    after: pageText.slice(end),
  };
}

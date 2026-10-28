import type { HighlightResponse, WireBox } from "@rag-book/api-contract";
import type { Page, ParsedDocument, TextItem } from "../core/index.js";

// Where a passage of the document's text is on the page, as rectangles.
//
// Every text item the loader read has a position (the start of its baseline, in PDF points from the
// bottom-left of the page), a width and a font size, and the span of the cleaned text it became.
// Cleaning moves the spans along with the edits (RAG-012), so a citation's character range can be
// laid over the items directly. The result is approximate by design: the PDF does not say how tall a
// glyph is or where inside an item a character falls, so the rectangles are estimates good enough to
// show a reader where to look.

/** The part of a line's height above the baseline, and below it, as multiples of the font size. */
const ASCENT = 0.95;
const DESCENT = 0.25;

/** Two boxes are on one line when their bottoms are within this fraction of the font size. */
const SAME_LINE = 0.4;
/** Boxes on one line are joined when the gap between them is under this many font sizes (a space). */
const JOIN_GAP = 0.9;

interface Piece {
  readonly box: WireBox;
  readonly fontSize: number;
}

/** The overlap of two half-open ranges, or undefined when they share no character. */
function overlap(
  a: { readonly start: number; readonly end: number },
  from: number,
  to: number,
): { readonly start: number; readonly end: number } | undefined {
  const start = Math.max(a.start, from);
  const end = Math.min(a.end, to);
  return start < end ? { start, end } : undefined;
}

/**
 * The rectangle of the part of `item` that lies in `[from, to)`. The item is taken as evenly spaced
 * text, so a part of it covers the same share of its width as of its characters. An item whose span is
 * empty or that has no width (a space the loader kept as an item) has no rectangle.
 */
function pieceOf(item: TextItem, from: number, to: number): Piece | undefined {
  const length = item.span.end - item.span.start;
  const shared = overlap(item.span, from, to);
  if (shared === undefined || length <= 0 || item.width <= 0 || item.fontSize <= 0) {
    return undefined;
  }
  const left = (shared.start - item.span.start) / length;
  const right = (shared.end - item.span.start) / length;
  return {
    fontSize: item.fontSize,
    box: {
      x: item.x + item.width * left,
      y: item.y - item.fontSize * DESCENT,
      width: item.width * (right - left),
      height: item.fontSize * (ASCENT + DESCENT),
    },
  };
}

/**
 * Joins the pieces of one line into one box, so a passage is a band per line and not a rectangle per
 * word. Pieces are taken in reading order; a piece joins the current line when it sits at about the
 * same height and starts just after the line's end.
 */
function mergeIntoLines(pieces: readonly Piece[]): WireBox[] {
  const lines: { box: WireBox; fontSize: number }[] = [];
  for (const piece of pieces) {
    const last = lines.at(-1);
    const sameLine =
      last !== undefined &&
      Math.abs(last.box.y - piece.box.y) <= SAME_LINE * piece.fontSize &&
      piece.box.x >= last.box.x - piece.fontSize &&
      piece.box.x - (last.box.x + last.box.width) <= JOIN_GAP * piece.fontSize;
    if (last === undefined || !sameLine) {
      lines.push({ box: piece.box, fontSize: piece.fontSize });
      continue;
    }
    const left = Math.min(last.box.x, piece.box.x);
    const right = Math.max(last.box.x + last.box.width, piece.box.x + piece.box.width);
    const bottom = Math.min(last.box.y, piece.box.y);
    const top = Math.max(last.box.y + last.box.height, piece.box.y + piece.box.height);
    last.box = { x: left, y: bottom, width: right - left, height: top - bottom };
    last.fontSize = Math.max(last.fontSize, piece.fontSize);
  }
  return lines.map((line) => line.box);
}

function boxesOnPage(page: Page, from: number, to: number): WireBox[] {
  const pieces: Piece[] = [];
  for (const item of page.items) {
    const piece = pieceOf(item, from, to);
    if (piece !== undefined) pieces.push(piece);
  }
  return mergeIntoLines(pieces);
}

/**
 * The pages that hold `[from, to)` of the document's text, each with the boxes of the passage on it.
 * A page counts when its text overlaps the range, whether or not it has positions.
 */
export function toWireHighlights(doc: ParsedDocument, from: number, to: number): HighlightResponse {
  const pages = doc.pages
    .filter((page) => overlap(page.span, from, to) !== undefined)
    .map((page) => ({ number: page.number, boxes: boxesOnPage(page, from, to) }));
  return { docId: doc.id, pages };
}

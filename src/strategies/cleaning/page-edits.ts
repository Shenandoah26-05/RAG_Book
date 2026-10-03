import { PAGE_SEPARATOR } from "../../core/index.js";
import type { Page, ParsedDocument, TextItem } from "../../core/index.js";
import { RagError } from "../../shared/index.js";

/** Replace `text.slice(start, end)` with `replacement`. Offsets are relative to the page's text. */
export interface TextEdit {
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
}

export interface AppliedEdits {
  readonly text: string;
  /** Where a position in the old text starts being in the new text. */
  mapStart(position: number): number;
  /** Where a position in the old text ends up in the new text, when it is the end of a range. */
  mapEnd(position: number): number;
}

/**
 * Applies non-overlapping edits to a text and returns the new text with functions to translate old
 * positions into new ones. A position that falls inside a replaced region maps to the edge of the
 * replacement that keeps the surviving part of a range: a range's start moves to the end of the
 * replacement, its end to the start, so deleted text never stays inside a range.
 */
export function applyEdits(text: string, edits: readonly TextEdit[]): AppliedEdits {
  const sorted = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);

  const regions: { oldStart: number; oldEnd: number; newStart: number; newEnd: number }[] = [];
  let result = "";
  let cursor = 0;
  for (const edit of sorted) {
    if (edit.start < cursor || edit.end < edit.start || edit.end > text.length) {
      throw new RagError(
        "INTERNAL",
        `Invalid text edit [${edit.start.toString()}, ${edit.end.toString()}): overlapping or out of range`,
      );
    }
    result += text.slice(cursor, edit.start);
    const newStart = result.length;
    result += edit.replacement;
    regions.push({ oldStart: edit.start, oldEnd: edit.end, newStart, newEnd: result.length });
    cursor = edit.end;
  }
  result += text.slice(cursor);

  const map = (position: number, side: "start" | "end"): number => {
    let shift = 0;
    for (const region of regions) {
      if (region.oldEnd <= position) {
        shift += region.newEnd - region.newStart - (region.oldEnd - region.oldStart);
      } else if (region.oldStart < position) {
        return side === "start" ? region.newEnd : region.newStart;
      } else {
        break;
      }
    }
    return position + shift;
  };

  return {
    text: result,
    mapStart: (position) => map(position, "start"),
    mapEnd: (position) => map(position, "end"),
  };
}

/**
 * Applies a plan of edits (one list per page, relative to that page's text) to a document and
 * rebuilds everything that depends on text offsets: page spans, text item spans and the document
 * text. An item keeps its font and position; its text and span follow the edits, and it is dropped
 * if all of its text was removed. Returns the same document when the plan changes nothing.
 */
export function editDocument(
  doc: ParsedDocument,
  plan: readonly (readonly TextEdit[])[],
): ParsedDocument {
  if (plan.every((edits) => edits.length === 0)) return doc;
  if (doc.sections.length > 0) {
    throw new RagError("INTERNAL", "Text cleaners must run before section detection");
  }

  const pages: Page[] = [];
  let offset = 0;
  doc.pages.forEach((page, index) => {
    const applied = applyEdits(page.text, plan[index] ?? []);

    const items: TextItem[] = [];
    for (const item of page.items) {
      const start = applied.mapStart(item.span.start - page.span.start);
      const end = applied.mapEnd(item.span.end - page.span.start);
      if (end <= start) continue;
      items.push({
        ...item,
        text: applied.text.slice(start, end),
        span: { start: offset + start, end: offset + end },
      });
    }

    pages.push({
      number: page.number,
      text: applied.text,
      span: { start: offset, end: offset + applied.text.length },
      items,
    });
    offset += applied.text.length + PAGE_SEPARATOR.length;
  });

  return { ...doc, text: pages.map((page) => page.text).join(PAGE_SEPARATOR), pages };
}

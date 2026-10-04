import type { ParsedDocument, TextItem } from "../../core/index.js";

/** A visual line of text on one page: the items that sit at the same height. */
export interface TextLine {
  /** Index into `doc.pages`. */
  readonly pageIndex: number;
  /** Where the line sits in the document's text, and the text itself. */
  readonly start: number;
  readonly end: number;
  readonly text: string;
  /** Height of the baseline, in PDF points from the bottom of the page. */
  readonly y: number;
  /** The font size that most of the line's characters use. */
  readonly fontSize: number;
  /** True when nearly all of the line's characters are bold. */
  readonly isBold: boolean;
  /** Characters that are not whitespace. */
  readonly chars: number;
}

/** Sizes closer than this are the same size: PDFs give 11.04 and 11 for the same text. */
export const SIZE_STEP = 0.5;
export const roundSize = (size: number): number => Math.round(size / SIZE_STEP) * SIZE_STEP;

const BOLD_SHARE = 0.9;

const visibleChars = (text: string): number => text.replace(/\s/g, "").length;

function toLine(
  doc: ParsedDocument,
  pageIndex: number,
  items: readonly TextItem[],
): TextLine | undefined {
  const first = items[0];
  const last = items.at(-1);
  if (first === undefined || last === undefined) return undefined;

  const charsBySize = new Map<number, number>();
  let chars = 0;
  let boldChars = 0;
  for (const item of items) {
    const count = visibleChars(item.text);
    chars += count;
    if (item.isBold) boldChars += count;
    const size = roundSize(item.fontSize);
    charsBySize.set(size, (charsBySize.get(size) ?? 0) + count);
  }
  if (chars === 0) return undefined; // only whitespace

  const [fontSize = first.fontSize] =
    [...charsBySize.entries()].sort((a, b) => b[1] - a[1])[0] ?? [];
  return {
    pageIndex,
    start: first.span.start,
    end: last.span.end,
    text: doc.text.slice(first.span.start, last.span.end),
    y: first.y,
    fontSize,
    isBold: boldChars / chars >= BOLD_SHARE,
    chars,
  };
}

/**
 * Groups each page's text items into lines, in reading order. Consecutive items belong to the same
 * line while their heights stay within a third of the font size.
 */
export function groupLines(doc: ParsedDocument): TextLine[] {
  const lines: TextLine[] = [];

  doc.pages.forEach((page, pageIndex) => {
    let current: TextItem[] = [];
    const flush = (): void => {
      const line = toLine(doc, pageIndex, current);
      if (line !== undefined) lines.push(line);
      current = [];
    };

    for (const item of page.items) {
      const reference = current[0];
      if (reference !== undefined) {
        const tolerance = Math.max(item.fontSize, reference.fontSize) / 3;
        if (Math.abs(item.y - reference.y) > tolerance) flush();
      }
      current.push(item);
    }
    flush();
  });
  return lines;
}

export interface TextStyle {
  readonly fontSize: number;
  readonly isBold: boolean;
}

/** The size and weight that most of the document's text uses: the body text. */
export function bodyStyle(lines: readonly TextLine[]): TextStyle | undefined {
  const charsByStyle = new Map<string, { style: TextStyle; chars: number }>();
  for (const { fontSize, isBold, chars } of lines) {
    const key = `${fontSize.toString()}|${isBold ? "bold" : "regular"}`;
    const entry = charsByStyle.get(key) ?? { style: { fontSize, isBold }, chars: 0 };
    entry.chars += chars;
    charsByStyle.set(key, entry);
  }
  return [...charsByStyle.values()].sort((a, b) => b.chars - a.chars)[0]?.style;
}

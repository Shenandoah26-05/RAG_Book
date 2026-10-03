import type { TextEdit } from "./page-edits.js";

export interface Line {
  /** 0-based position of the line in the page. */
  readonly index: number;
  readonly start: number;
  /** Offset just after the last character, excluding the line break. */
  readonly end: number;
  readonly text: string;
}

export function splitLines(text: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  for (const [index, lineText] of text.split("\n").entries()) {
    lines.push({ index, start, end: start + lineText.length, text: lineText });
    start += lineText.length + 1;
  }
  return lines;
}

export const isBlank = (line: Line): boolean => line.text.trim() === "";

/**
 * Headers and footers sit at the top and bottom of a page: the first and last `count` lines that
 * have text.
 */
export function edgeLines(lines: readonly Line[], count: number): Line[] {
  const withText = lines.filter((line) => !isBlank(line));
  return [...withText.slice(0, count), ...withText.slice(-count)].filter(
    (line, i, all) => all.indexOf(line) === i,
  );
}

/**
 * Edits that delete whole lines, with their line breaks. Neighbouring lines become one edit. At
 * the top or bottom of the page the deletion also takes the blank lines next to it, so removing a
 * footer does not leave a blank line at the end of the page.
 */
export function removeLines(text: string, lines: readonly Line[]): TextEdit[] {
  const all = splitLines(text);
  const sorted = [...lines].sort((a, b) => a.index - b.index);
  const edits: TextEdit[] = [];

  let i = 0;
  while (i < sorted.length) {
    let last = i;
    while (sorted[last + 1]?.index === (sorted[last]?.index ?? 0) + 1) last++;
    const first = sorted[i];
    const final = sorted[last];
    i = last + 1;
    if (first === undefined || final === undefined) continue;

    let from = first.index;
    let to = final.index;
    if (to === all.length - 1) {
      while (from > 0 && isBlank(all[from - 1] ?? first)) from--;
    }
    if (from === 0) {
      while (to < all.length - 1 && isBlank(all[to + 1] ?? final)) to++;
    }

    const start = all[from]?.start ?? first.start;
    const end = all[to]?.end ?? final.end;
    edits.push(
      to === all.length - 1 && start > 0
        ? { start: start - 1, end, replacement: "" }
        : { start, end: Math.min(end + 1, text.length), replacement: "" },
    );
  }
  return edits;
}

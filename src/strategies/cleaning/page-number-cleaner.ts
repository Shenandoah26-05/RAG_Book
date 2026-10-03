import type { Cleaner, ParsedDocument } from "../../core/index.js";
import { codePoint, EM_DASH, EN_DASH } from "./characters.js";
import { edgeLines, removeLines, splitLines } from "./lines.js";
import type { Line } from "./lines.js";
import { editDocument } from "./page-edits.js";

/** How many lines at the top and at the bottom of a page may hold a page number. */
const EDGE_LINES = 3;
/** A numbering is accepted when this many pages agree on it. */
const MIN_PAGES = 2;

const ARABIC = /^(?:page\s+)?(\d{1,4})(?:\s*(?:of|\/)\s*\d{1,4})?$/i;
/** "- 12 -", with a hyphen, en dash or em dash on each side. */
const DASH = `[-${codePoint(EN_DASH)}${codePoint(EM_DASH)}]`;
const DASHED = new RegExp(`^${DASH}\\s*(\\d{1,4})\\s*${DASH}$`, "u");
const ROMAN = /^(?:page\s+)?(m{0,3}(?:cm|cd|d?c{0,3})(?:xc|xl|l?x{0,3})(?:ix|iv|v?i{0,3}))$/i;

const ROMAN_VALUES: Readonly<Record<string, number>> = {
  i: 1,
  v: 5,
  x: 10,
  l: 50,
  c: 100,
  d: 500,
  m: 1000,
};

function romanToNumber(roman: string): number {
  let total = 0;
  const letters = roman.toLowerCase().split("");
  letters.forEach((letter, i) => {
    const value = ROMAN_VALUES[letter] ?? 0;
    const next = ROMAN_VALUES[letters[i + 1] ?? ""] ?? 0;
    total += value < next ? -value : value;
  });
  return total;
}

interface Candidate {
  readonly line: Line;
  /** "arabic" or "roman": front matter and the main text are numbered separately. */
  readonly kind: "arabic" | "roman";
  /** Printed number minus the PDF's page number. A real page number keeps the same offset. */
  readonly offset: number;
}

function candidateFor(line: Line, pageNumber: number): Candidate | undefined {
  const text = line.text.trim();

  const arabic = ARABIC.exec(text) ?? DASHED.exec(text);
  if (arabic?.[1] !== undefined) {
    return { line, kind: "arabic", offset: Number(arabic[1]) - pageNumber };
  }
  const roman = ROMAN.exec(text);
  if (roman?.[1] !== undefined && roman[1] !== "") {
    return { line, kind: "roman", offset: romanToNumber(roman[1]) - pageNumber };
  }
  return undefined;
}

/**
 * Removes lines that only hold a page number ("12", "- 12 -", "Page 12 of 300", "xii"). A lone
 * number can also be real content, so a line only counts when numbers at the top or bottom of
 * several pages follow the pages: printed number minus PDF page number is the same each time.
 */
export class PageNumberCleaner implements Cleaner {
  readonly name = "page-numbers";

  clean(doc: ParsedDocument): ParsedDocument {
    const pageLines = doc.pages.map((page) => splitLines(page.text));

    const byPage = pageLines.map((lines, i) => {
      const number = doc.pages[i]?.number ?? 0;
      return edgeLines(lines, EDGE_LINES).flatMap((line) => candidateFor(line, number) ?? []);
    });

    const support = new Map<string, Set<number>>();
    byPage.forEach((candidates, pageIndex) => {
      for (const { kind, offset } of candidates) {
        const key = `${kind}:${offset.toString()}`;
        support.set(key, (support.get(key) ?? new Set()).add(pageIndex));
      }
    });

    const plan = doc.pages.map((page, i) => {
      const accepted = (byPage[i] ?? []).filter(
        ({ kind, offset }) => (support.get(`${kind}:${offset.toString()}`)?.size ?? 0) >= MIN_PAGES,
      );
      return removeLines(
        page.text,
        accepted.map((candidate) => candidate.line),
      );
    });
    return editDocument(doc, plan);
  }
}

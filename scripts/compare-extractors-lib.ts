import type { ParsedDocument } from "../src/core/index.js";

export const normalizeWhitespace = (text: string): string => text.replace(/\s+/g, " ").trim();

export interface Difference {
  /** Index of the first character that differs. */
  readonly index: number;
  /** A few characters around it in each text, with whitespace made visible. */
  readonly a: string;
  readonly b: string;
}

/** Where two strings first differ, or undefined if they are equal. */
export function firstDifference(a: string, b: string, context = 30): Difference | undefined {
  if (a === b) return undefined;
  let index = 0;
  while (index < a.length && index < b.length && a[index] === b[index]) index++;
  const around = (text: string): string =>
    JSON.stringify(text.slice(Math.max(0, index - context), index + context));
  return { index, a: around(a), b: around(b) };
}

export interface DocumentSummary {
  readonly pages: number;
  readonly emptyPages: number;
  readonly chars: number;
  readonly words: number;
  readonly items: number;
  readonly boldItems: number;
  readonly fontNames: readonly string[];
  /** Font sizes with the most text, as [size, characters], biggest first. */
  readonly topSizes: readonly (readonly [number, number])[];
}

export function summarize(doc: ParsedDocument, topN = 5): DocumentSummary {
  const items = doc.pages.flatMap((page) => page.items);
  const charsBySize = new Map<number, number>();
  for (const item of items) {
    charsBySize.set(item.fontSize, (charsBySize.get(item.fontSize) ?? 0) + item.text.length);
  }
  const text = normalizeWhitespace(doc.text);
  return {
    pages: doc.pageCount,
    emptyPages: doc.pages.filter((page) => page.text.trim() === "").length,
    chars: doc.text.length,
    words: text === "" ? 0 : text.split(" ").length,
    items: items.length,
    boldItems: items.filter((item) => item.isBold).length,
    fontNames: [...new Set(items.map((item) => item.fontName))].sort(),
    topSizes: [...charsBySize.entries()].sort((x, y) => y[1] - x[1]).slice(0, topN),
  };
}

export interface PageDifference {
  readonly page: number;
  readonly difference: Difference;
  /** True if the pages are equal once whitespace is normalised. */
  readonly whitespaceOnly: boolean;
}

export interface Comparison {
  readonly pages: number;
  readonly identical: number;
  readonly identicalIgnoringWhitespace: number;
  readonly differing: readonly PageDifference[];
}

/** Compares two documents page by page. Pages beyond the shorter document count as different. */
export function compareDocuments(a: ParsedDocument, b: ParsedDocument): Comparison {
  const pages = Math.max(a.pages.length, b.pages.length);
  const differing: PageDifference[] = [];
  let identicalIgnoringWhitespace = 0;

  for (let i = 0; i < pages; i++) {
    const textA = a.pages[i]?.text ?? "";
    const textB = b.pages[i]?.text ?? "";
    const difference = firstDifference(textA, textB);
    if (difference === undefined) {
      identicalIgnoringWhitespace++;
      continue;
    }
    const whitespaceOnly = normalizeWhitespace(textA) === normalizeWhitespace(textB);
    if (whitespaceOnly) identicalIgnoringWhitespace++;
    differing.push({ page: i + 1, difference, whitespaceOnly });
  }
  return { pages, identical: pages - differing.length, identicalIgnoringWhitespace, differing };
}

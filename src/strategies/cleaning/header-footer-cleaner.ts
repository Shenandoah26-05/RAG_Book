import type { Cleaner, ParsedDocument } from "../../core/index.js";
import { edgeLines, removeLines, splitLines } from "./lines.js";
import { editDocument } from "./page-edits.js";

const EDGE_LINES = 3;
/** Below this many pages with text, "repeated" means nothing. */
const MIN_PAGES = 3;

/** Digits vary from page to page ("Page 4", "Page 5"), so compare lines with digits masked. */
const repeatKey = (text: string): string =>
  text.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim();

/**
 * Removes running headers and footers: lines at the top or bottom of the page that repeat on more
 * than half of the pages. Books often alternate (book title on even pages, chapter on odd ones), so
 * a line also counts when it repeats on more than half of the pages with the same parity.
 */
export class HeaderFooterCleaner implements Cleaner {
  readonly name = "headers-footers";

  clean(doc: ParsedDocument): ParsedDocument {
    const pageLines = doc.pages.map((page) => splitLines(page.text));
    const hasText = pageLines.map((lines) => lines.some((line) => line.text.trim() !== ""));
    const textPages = hasText.filter(Boolean).length;
    if (textPages < MIN_PAGES) return doc;

    /** Which pages show each (masked) line near their top or bottom. */
    const pagesWith = new Map<string, Set<number>>();
    const candidates = pageLines.map((lines) =>
      edgeLines(lines, EDGE_LINES).map((line) => ({ line, key: repeatKey(line.text) })),
    );
    candidates.forEach((found, pageIndex) => {
      for (const { key } of found) {
        pagesWith.set(key, (pagesWith.get(key) ?? new Set()).add(pageIndex));
      }
    });

    const textPagesOfParity = [0, 1].map(
      (parity) => hasText.filter((has, i) => has && i % 2 === parity).length,
    );
    const repeats = (key: string): boolean => {
      const pages = [...(pagesWith.get(key) ?? [])];
      if (pages.length > textPages / 2) return true;
      return [0, 1].some((parity) => {
        const total = textPagesOfParity[parity] ?? 0;
        const count = pages.filter((p) => p % 2 === parity).length;
        return total >= MIN_PAGES && count > total / 2;
      });
    };

    const plan = doc.pages.map((page, i) =>
      removeLines(
        page.text,
        (candidates[i] ?? [])
          .filter(({ key }) => key !== "" && repeats(key))
          .map(({ line }) => line),
      ),
    );
    return editDocument(doc, plan);
  }
}

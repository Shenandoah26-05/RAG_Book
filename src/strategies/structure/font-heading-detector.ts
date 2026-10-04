import type { ParsedDocument, SectionDetector, Section } from "../../core/index.js";
import { bodyStyle, groupLines, SIZE_STEP } from "./text-lines.js";
import type { TextLine, TextStyle } from "./text-lines.js";

export interface FontHeadingOptions {
  /** A line is a heading when its font is at least this many times the body size. Default 1.15. */
  readonly minSizeRatio?: number;
  /** A bold line at body size is a heading only if it has at most this many characters. Default 80. */
  readonly maxBoldBodyChars?: number;
  /** A heading can have at most this many characters, however its lines are merged. Default 200. */
  readonly maxTitleChars?: number;
  /** The deepest level reported; deeper styles are folded into it. Default 6. */
  readonly maxLevels?: number;
  /**
   * A style that makes up more than this share of all lines is not a heading style (a deck where
   * every line is bold has no headings). Only checked on documents of at least 20 lines. Default 0.3.
   */
  readonly maxStyleShare?: number;
}

const DEFAULTS = {
  minSizeRatio: 1.15,
  maxBoldBodyChars: 80,
  maxTitleChars: 200,
  maxLevels: 6,
  maxStyleShare: 0.3,
} as const;

const MIN_LINES_FOR_SHARE_CHECK = 20;

interface Heading {
  readonly lines: readonly TextLine[];
  readonly style: TextStyle;
  readonly pageIndex: number;
  readonly start: number;
  readonly end: number;
  readonly title: string;
}

interface Node {
  readonly heading: Heading;
  /** Rank of the heading's style: 1 for the largest. */
  readonly rank: number;
  readonly depth: number;
  readonly children: Node[];
  end: number;
}

const styleKey = ({ fontSize, isBold }: TextStyle): string =>
  `${fontSize.toString()}|${isBold ? "bold" : "regular"}`;

const normalize = (text: string): string => text.replace(/\s+/g, " ").trim();

/**
 * Finds headings from how they look: larger than the body text, or bold and short. Each distinct
 * style (size and weight) is a level, the largest first, so a 24 pt bold title is level 1 and a
 * 16 pt bold one is level 2. The headings are then nested into a tree of sections.
 *
 * Needs text items with font sizes, so it works with any loader; without bold information
 * (unpdf) only larger-than-body headings are found. It does not use heading numbers ("1.2") or
 * the table of contents.
 */
export class FontHeadingDetector implements SectionDetector {
  readonly name = "font-size";
  readonly #options: Required<FontHeadingOptions>;

  constructor(options: FontHeadingOptions = {}) {
    this.#options = { ...DEFAULTS, ...options };
  }

  detect(doc: ParsedDocument): ParsedDocument {
    const lines = groupLines(doc);
    const body = bodyStyle(lines);
    if (body === undefined) return doc;

    const headings = this.#mergeWrapped(lines, this.#headingLines(lines, body));
    const kept = this.#dropOverusedStyles(headings, lines.length);
    if (kept.length === 0) return doc;

    return { ...doc, sections: this.#buildTree(doc, kept) };
  }

  /**
   * Pages where the body-size text is mostly bold. Some PDFs mark a whole page's font as bold, and
   * there "bold" says nothing about which lines are headings.
   */
  #boldBodyPages(lines: readonly TextLine[], body: TextStyle): Set<number> {
    const chars = new Map<number, { all: number; bold: number }>();
    for (const line of lines) {
      if (Math.abs(line.fontSize - body.fontSize) > SIZE_STEP) continue;
      const page = chars.get(line.pageIndex) ?? { all: 0, bold: 0 };
      page.all += line.chars;
      if (line.isBold) page.bold += line.chars;
      chars.set(line.pageIndex, page);
    }
    return new Set(
      [...chars.entries()].filter(([, page]) => page.bold / page.all > 0.5).map(([index]) => index),
    );
  }

  /** The lines that look like (part of) a heading. */
  #headingLines(lines: readonly TextLine[], body: TextStyle): Set<TextLine> {
    const { minSizeRatio, maxBoldBodyChars, maxTitleChars } = this.#options;
    const boldBodyPages = this.#boldBodyPages(lines, body);
    const found = new Set<TextLine>();

    for (const line of lines) {
      if (!/\p{L}/u.test(line.text) || line.text.length > maxTitleChars) continue;
      const larger = line.fontSize >= body.fontSize * minSizeRatio;
      const boldAtBodySize =
        line.isBold &&
        !body.isBold &&
        !boldBodyPages.has(line.pageIndex) &&
        line.fontSize >= body.fontSize &&
        line.text.length <= maxBoldBodyChars;
      if (larger || boldAtBodySize) found.add(line);
    }
    return found;
  }

  /** A title that wraps onto several lines of the same style is one heading. */
  #mergeWrapped(lines: readonly TextLine[], candidates: ReadonlySet<TextLine>): Heading[] {
    const headings: Heading[] = [];
    let run: TextLine[] = [];

    const flush = (): void => {
      const first = run[0];
      const last = run.at(-1);
      if (first === undefined || last === undefined) return;
      const title = normalize(run.map((line) => line.text).join(" "));
      if (title.length <= this.#options.maxTitleChars) {
        headings.push({
          lines: run,
          style: { fontSize: first.fontSize, isBold: first.isBold },
          pageIndex: first.pageIndex,
          start: first.start,
          end: last.end,
          title,
        });
      }
      run = [];
    };

    lines.forEach((line, index) => {
      if (!candidates.has(line)) {
        flush();
        return;
      }
      const previous = lines[index - 1];
      const continues =
        previous !== undefined &&
        candidates.has(previous) &&
        previous.pageIndex === line.pageIndex &&
        styleKey(previous) === styleKey(line) &&
        previous.y - line.y <= line.fontSize * 2;
      if (!continues) flush();
      run.push(line);
    });
    flush();
    return headings;
  }

  #dropOverusedStyles(headings: readonly Heading[], totalLines: number): Heading[] {
    if (totalLines < MIN_LINES_FOR_SHARE_CHECK) return [...headings];

    const linesByStyle = new Map<string, number>();
    for (const heading of headings) {
      const key = styleKey(heading.style);
      linesByStyle.set(key, (linesByStyle.get(key) ?? 0) + heading.lines.length);
    }
    return headings.filter(
      (h) => (linesByStyle.get(styleKey(h.style)) ?? 0) / totalLines <= this.#options.maxStyleShare,
    );
  }

  #buildTree(doc: ParsedDocument, headings: readonly Heading[]): Section[] {
    // Rank styles: larger first, and bold before regular at the same size.
    const styles = [...new Map(headings.map((h) => [styleKey(h.style), h.style])).values()].sort(
      (a, b) => b.fontSize - a.fontSize || Number(b.isBold) - Number(a.isBold),
    );
    const rankOf = new Map(styles.map((style, i) => [styleKey(style), i + 1]));

    const roots: Node[] = [];
    const open: Node[] = [];
    for (const heading of headings) {
      const rank = Math.min(rankOf.get(styleKey(heading.style)) ?? 1, this.#options.maxLevels);

      // A heading of the same or a higher rank ends the sections that are still open below it.
      while ((open.at(-1)?.rank ?? 0) >= rank) {
        const closed = open.pop();
        if (closed !== undefined) closed.end = heading.start;
      }
      const node: Node = {
        heading,
        rank,
        depth: open.length + 1,
        children: [],
        end: doc.text.length,
      };
      (open.at(-1)?.children ?? roots).push(node);
      open.push(node);
    }

    return roots.map((node) => this.#toSection(doc, node));
  }

  #toSection(doc: ParsedDocument, node: Node): Section {
    const { heading } = node;

    let end = node.end;
    while (end > heading.start && /\s/.test(doc.text[end - 1] ?? "")) end--;
    end = Math.max(end, heading.end);

    const lastPage = doc.pages.findLast((page) => page.span.start < end);
    return {
      title: heading.title,
      level: node.depth,
      pageStart: doc.pages[heading.pageIndex]?.number ?? 1,
      pageEnd: lastPage?.number ?? doc.pages[heading.pageIndex]?.number ?? 1,
      span: { start: heading.start, end },
      titleSpan: { start: heading.start, end: heading.end },
      children: node.children.map((child) => this.#toSection(doc, child)),
    };
  }
}

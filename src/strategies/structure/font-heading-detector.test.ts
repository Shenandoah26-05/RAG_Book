import { describe, expect, it } from "vitest";
import type { ParsedDocument, Section } from "../../core/index.js";
import { expectConsistent, makeDocument } from "../../testing/make-document.testing.js";
import { FontHeadingDetector } from "./font-heading-detector.js";
import type { FontHeadingOptions } from "./font-heading-detector.js";

/** A line of body text, long enough that body text clearly outweighs the headings. */
const body = (label: string): string => `this is an ordinary line of body text, number ${label}`;

interface Style {
  readonly size: number;
  readonly bold?: boolean;
}

/** Builds a document where chosen lines get a font size and weight; all others are 12 pt regular. */
function documentWith(
  pages: readonly string[],
  styles: Readonly<Record<string, Style>>,
): ParsedDocument {
  return makeDocument(pages, {
    fontSizeOf: (line) => styles[line]?.size ?? 12,
    isBold: (line) => styles[line]?.bold ?? false,
  });
}

const detect = (doc: ParsedDocument, options?: FontHeadingOptions): readonly Section[] =>
  new FontHeadingDetector(options).detect(doc).sections;

const titles = (sections: readonly Section[]): string[] =>
  sections.flatMap((s) => [s.title, ...titles(s.children)]);

const TITLE_1: Style = { size: 24, bold: true };
const TITLE_2: Style = { size: 16, bold: true };

/** Every section must sit inside its parent, siblings must not overlap, and titles must be real. */
function expectSectionInvariants(
  doc: ParsedDocument,
  sections: readonly Section[],
  parent?: Section,
): void {
  let previousEnd = parent?.titleSpan.end ?? 0;
  for (const section of sections) {
    expect(section.span.start).toBeLessThan(section.span.end);
    expect(section.span.start).toBeGreaterThanOrEqual(previousEnd);
    expect(section.titleSpan.start).toBe(section.span.start);
    expect(section.titleSpan.end).toBeLessThanOrEqual(section.span.end);
    expect(
      doc.text.slice(section.titleSpan.start, section.titleSpan.end).replace(/\s+/g, " "),
    ).toBe(section.title);
    if (parent !== undefined) {
      expect(section.span.start).toBeGreaterThanOrEqual(parent.span.start);
      expect(section.span.end).toBeLessThanOrEqual(parent.span.end);
      expect(section.level).toBe(parent.level + 1);
    } else {
      expect(section.level).toBe(1);
    }
    expect(section.pageStart).toBeLessThanOrEqual(section.pageEnd);
    expectSectionInvariants(doc, section.children, section);
    previousEnd = section.span.end;
  }
}

describe("FontHeadingDetector: levels and tree", () => {
  const pages = [
    ["Chapter One", body("a"), body("b")].join("\n"),
    ["1.1 Sub", body("c"), "Chapter Two", body("d")].join("\n"),
  ];
  const doc = documentWith(pages, {
    "Chapter One": TITLE_1,
    "Chapter Two": TITLE_1,
    "1.1 Sub": TITLE_2,
  });

  it("ranks larger headings above smaller ones and nests them", () => {
    const sections = detect(doc);

    expect(sections.map((s) => [s.title, s.level])).toEqual([
      ["Chapter One", 1],
      ["Chapter Two", 1],
    ]);
    expect(sections[0]?.children.map((s) => [s.title, s.level])).toEqual([["1.1 Sub", 2]]);
    expect(sections[1]?.children).toEqual([]);
  });

  it("gives each section a page range, with subsections inside their parent", () => {
    const [one, two] = detect(doc);
    expect([one?.pageStart, one?.pageEnd]).toEqual([1, 2]);
    expect([one?.children[0]?.pageStart, one?.children[0]?.pageEnd]).toEqual([2, 2]);
    expect([two?.pageStart, two?.pageEnd]).toEqual([2, 2]);
  });

  it("gives each section a span from its heading to the next heading of the same or a higher level", () => {
    const result = new FontHeadingDetector().detect(doc);
    const [one, two] = result.sections;

    expect(result.text.slice(one?.span.start, one?.span.end)).toContain(body("c"));
    expect(result.text.slice(one?.span.start, one?.span.end)).not.toContain("Chapter Two");
    expect(result.text.slice(two?.span.start, two?.span.end)).toBe(`Chapter Two\n${body("d")}`);
    expect(result.text.slice(one?.children[0]?.span.start, one?.children[0]?.span.end)).toBe(
      `1.1 Sub\n${body("c")}`,
    );
    expectSectionInvariants(result, result.sections);
  });

  it("records where the heading text itself sits", () => {
    const result = new FontHeadingDetector().detect(doc);
    const [one] = result.sections;
    expect(result.text.slice(one?.titleSpan.start, one?.titleSpan.end)).toBe("Chapter One");
  });

  it("keeps everything else in the document, and does not change the original", () => {
    const result = new FontHeadingDetector().detect(doc);
    expect(result).toMatchObject({ id: doc.id, text: doc.text, pageCount: doc.pageCount });
    expect(result.pages).toBe(doc.pages);
    expect(doc.sections).toEqual([]);
    expectConsistent(result);
  });

  it("goes three levels deep, and ranks by size", () => {
    const deep = documentWith(
      [["Part", body("a"), "Chapter", body("b"), "Section", body("c")].join("\n")],
      {
        Part: { size: 28, bold: true },
        Chapter: { size: 20, bold: true },
        Section: { size: 15, bold: true },
      },
    );
    const [part] = detect(deep);
    expect(part?.level).toBe(1);
    expect(part?.children[0]?.level).toBe(2);
    expect(part?.children[0]?.children[0]).toMatchObject({ title: "Section", level: 3 });
  });

  it("uses depth in the tree as the level when a style is skipped", () => {
    // three styles exist (24, 18, 14) but the 14 pt heading sits directly under a 24 pt one
    const skipped = documentWith(
      [
        ["Big", body("a"), "Medium", body("b"), "Big Again", body("c"), "Small", body("d")].join(
          "\n",
        ),
      ],
      {
        Big: { size: 24, bold: true },
        "Big Again": { size: 24, bold: true },
        Medium: { size: 18, bold: true },
        Small: { size: 14, bold: true },
      },
    );
    const sections = detect(skipped);
    expect(sections.map((s) => s.title)).toEqual(["Big", "Big Again"]);
    expect(sections[1]?.children[0]).toMatchObject({ title: "Small", level: 2 });
    expectSectionInvariants(new FontHeadingDetector().detect(skipped), sections);
  });

  it("treats sizes that differ by a hair as the same size", () => {
    const hairs = documentWith([["Chapter A", body("a"), "Chapter B", body("b")].join("\n")], {
      "Chapter A": { size: 24, bold: true },
      "Chapter B": { size: 24.04, bold: true },
    });
    expect(detect(hairs).map((s) => s.level)).toEqual([1, 1]);
  });

  it("puts bold before regular at the same size", () => {
    const mixed = documentWith([["Bold Title", body("a"), "Regular Title", body("b")].join("\n")], {
      "Bold Title": { size: 20, bold: true },
      "Regular Title": { size: 20 },
    });
    // at the same size, bold ranks higher: the regular heading becomes its subsection
    const [bold] = detect(mixed);
    expect(bold?.title).toBe("Bold Title");
    expect(bold?.children.map((s) => [s.title, s.level])).toEqual([["Regular Title", 2]]);

    // and the other way round, the bold heading closes the regular one and starts a new section
    const reversed = documentWith(
      [["Regular Title", body("a"), "Bold Title", body("b")].join("\n")],
      { "Regular Title": { size: 20 }, "Bold Title": { size: 20, bold: true } },
    );
    expect(detect(reversed).map((s) => [s.title, s.level])).toEqual([
      ["Regular Title", 1],
      ["Bold Title", 1],
    ]);
  });

  it("folds styles deeper than maxLevels into the last level", () => {
    const styles: Record<string, Style> = {
      A: { size: 30, bold: true },
      B: { size: 24, bold: true },
      C: { size: 18, bold: true },
      D: { size: 15, bold: true },
    };
    const doc4 = documentWith(
      [["A", body("1"), "B", body("2"), "C", body("3"), "D", body("4")].join("\n")],
      styles,
    );
    const flat = (s: readonly Section[]): number[] =>
      s.flatMap((x) => [x.level, ...flat(x.children)]);
    expect(Math.max(...flat(detect(doc4)))).toBe(4);
    expect(Math.max(...flat(detect(doc4, { maxLevels: 2 })))).toBe(2);
    expect(titles(detect(doc4, { maxLevels: 2 }))).toEqual(["A", "B", "C", "D"]);
  });

  it("starts the first section at the first heading, not at the start of the document", () => {
    const withPreface = documentWith(
      [["Preface text here", body("a"), "Chapter One", body("b")].join("\n")],
      {
        "Chapter One": TITLE_1,
      },
    );
    const result = new FontHeadingDetector().detect(withPreface);
    expect(result.sections[0]?.span.start).toBe(withPreface.text.indexOf("Chapter One"));
    expect(result.sections[0]?.span.start).toBeGreaterThan(0);
  });

  it("trims the page break from the end of a section that ends where a page ends", () => {
    const twoChapters = documentWith([`Chapter One\n${body("a")}`, `Chapter Two\n${body("b")}`], {
      "Chapter One": TITLE_1,
      "Chapter Two": TITLE_1,
    });
    const [one, two] = detect(twoChapters);
    expect([one?.pageStart, one?.pageEnd]).toEqual([1, 1]);
    expect([two?.pageStart, two?.pageEnd]).toEqual([2, 2]);
  });

  it("runs the last section to the end of the document, across pages", () => {
    const long = documentWith(["Chapter One\n" + body("a"), body("b"), body("c")], {
      "Chapter One": TITLE_1,
    });
    const [one] = detect(long);
    expect([one?.pageStart, one?.pageEnd]).toEqual([1, 3]);
    expect(one?.span.end).toBe(long.text.length);
  });
});

describe("FontHeadingDetector: what counts as a heading", () => {
  it("joins a title that wraps onto several lines into one heading", () => {
    const wrapped = documentWith([["Introduction to", "Retrieval Systems", body("a")].join("\n")], {
      "Introduction to": TITLE_1,
      "Retrieval Systems": TITLE_1,
    });
    const result = new FontHeadingDetector().detect(wrapped);

    expect(result.sections.map((s) => s.title)).toEqual(["Introduction to Retrieval Systems"]);
    expect(
      result.text.slice(result.sections[0]?.titleSpan.start, result.sections[0]?.titleSpan.end),
    ).toBe("Introduction to\nRetrieval Systems");
  });

  it("keeps headings apart when body text sits between them", () => {
    const apart = documentWith([["Chapter A", body("a"), "Chapter B", body("b")].join("\n")], {
      "Chapter A": TITLE_1,
      "Chapter B": TITLE_1,
    });
    expect(titles(detect(apart))).toEqual(["Chapter A", "Chapter B"]);
  });

  it("does not merge headings across a page break", () => {
    // one heading ends a page and the next starts the following one, with the same style
    const acrossPages = documentWith([`${body("a")}\nChapter A`, `Chapter B\n${body("b")}`], {
      "Chapter A": TITLE_1,
      "Chapter B": TITLE_1,
    });
    expect(titles(detect(acrossPages))).toEqual(["Chapter A", "Chapter B"]);
  });

  it("finds headings that are bold at body size, when they are short", () => {
    const boldBody = documentWith([["Definitions", body("a"), "Examples", body("b")].join("\n")], {
      Definitions: { size: 12, bold: true },
      Examples: { size: 12, bold: true },
    });
    expect(titles(detect(boldBody))).toEqual(["Definitions", "Examples"]);
  });

  it("ignores a long bold line at body size (that is emphasis, not a heading)", () => {
    const long =
      "A long bold sentence that is clearly part of the running text and not a title at all, honest.";
    const doc = documentWith([[long, body("a"), body("b")].join("\n")], {
      [long]: { size: 12, bold: true },
    });
    expect(detect(doc)).toEqual([]);
  });

  it("ignores bold lines on a page where all the body text is bold, but not on other pages", () => {
    // some PDFs mark a whole page's font as bold; there, bold says nothing about headings
    const boldPage = [body("a"), body("b"), body("c")].join("\n");
    const withHeading = ["Real Heading", body("d"), body("e")].join("\n");
    const plain = [body("f"), body("g"), body("h")].join("\n");
    const doc = makeDocument([boldPage, withHeading, plain, plain], {
      isBold: (line) => line === "Real Heading" || boldPage.includes(line),
    });
    // without the page rule, the three bold body lines on page 1 would all be headings
    expect(titles(detect(doc))).toEqual(["Real Heading"]);
  });

  it("ignores bold lines when the body text itself is bold", () => {
    const allBold = makeDocument([[body("a"), body("b"), "Short", body("c")].join("\n")], {
      isBold: () => true,
    });
    expect(detect(allBold)).toEqual([]);
  });

  it("finds headings that are only larger, with no weight information (as unpdf reports)", () => {
    const sizeOnly = documentWith([["Chapter One", body("a")].join("\n")], {
      "Chapter One": { size: 24 },
    });
    expect(titles(detect(sizeOnly))).toEqual(["Chapter One"]);
  });

  it("ignores text that is smaller than the body text", () => {
    const small = documentWith([[body("a"), "Footnote 1", body("b")].join("\n")], {
      "Footnote 1": { size: 8, bold: true },
    });
    expect(detect(small)).toEqual([]);
  });

  it("ignores lines with no letters, such as stray numbers", () => {
    const numbers = documentWith([["12", body("a"), "Chapter One", body("b")].join("\n")], {
      "12": TITLE_1,
      "Chapter One": TITLE_1,
    });
    expect(titles(detect(numbers))).toEqual(["Chapter One"]);
  });

  it("ignores a style that makes up most of the lines (a deck where everything is bold)", () => {
    const lines = Array.from({ length: 30 }, (_, i) =>
      i % 2 === 0 ? `Point ${String.fromCharCode(65 + i)}` : body(String(i)),
    );
    const styles: Record<string, Style> = {};
    for (const line of lines.filter((l) => l.startsWith("Point")))
      styles[line] = { size: 12, bold: true };
    expect(detect(documentWith([lines.join("\n")], styles))).toEqual([]);
  });

  it("honours a custom size ratio", () => {
    const slight = documentWith([["Slightly Bigger", body("a")].join("\n")], {
      "Slightly Bigger": { size: 13 },
    });
    expect(detect(slight)).toEqual([]);
    expect(titles(detect(slight, { minSizeRatio: 1.05 }))).toEqual(["Slightly Bigger"]);
  });

  it("returns the same document when there are no headings", () => {
    const plain = makeDocument([body("a"), body("b")]);
    expect(new FontHeadingDetector().detect(plain)).toBe(plain);
  });

  it("returns the same document when the pages have no text items", () => {
    const withItems = makeDocument(["Chapter One\nsome text"]);
    const noItems = {
      ...withItems,
      pages: withItems.pages.map((page) => ({ ...page, items: [] })),
    };
    expect(new FontHeadingDetector().detect(noItems)).toBe(noItems);
  });

  it("is named for the config value", () => {
    expect(new FontHeadingDetector().name).toBe("font-size");
  });
});

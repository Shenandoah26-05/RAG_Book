import { describe, expect, it } from "vitest";
import { buildPage, pickTitle } from "./pdf-pages.js";
import type { FontInfo, RawTextItem } from "./pdf-pages.js";

const REGULAR: FontInfo = { name: "Helvetica", isBold: false };
const BOLD: FontInfo = { name: "Helvetica-Bold", isBold: true };
const fontOf = (id: string): FontInfo => (id === "bold" ? BOLD : REGULAR);

function item(str: string, fontName: string, size: number, x: number, y: number, hasEOL = false) {
  return {
    str,
    fontName,
    transform: [size, 0, 0, size, x, y],
    width: str.length * 5,
    hasEOL,
  } satisfies RawTextItem;
}

describe("buildPage", () => {
  it("joins item text and adds a newline where a line ends", () => {
    const page = buildPage(
      1,
      [
        item("Hello", "r", 12, 72, 700),
        item(" world", "r", 12, 100, 700, true),
        item("Next line", "r", 12, 72, 686),
      ],
      fontOf,
      0,
    );
    expect(page.text).toBe("Hello world\nNext line");
    expect(page.number).toBe(1);
  });

  it("treats pdf.js's empty end-of-line items as a newline, not as an item", () => {
    const page = buildPage(
      1,
      [
        item("Title", "bold", 24, 72, 700),
        item("", "r", 12, 72, 660, true),
        item("Body", "r", 12, 72, 660),
      ],
      fontOf,
      0,
    );
    expect(page.text).toBe("Title\nBody");
    expect(page.items.map((i) => i.text)).toEqual(["Title", "Body"]);
  });

  it("gives each item a span that slices out exactly its text, relative to the document", () => {
    const offset = 1000;
    const page = buildPage(
      3,
      [item("Ab", "r", 12, 0, 0), item("", "r", 12, 0, 0, true), item("Cde", "r", 12, 0, 0)],
      fontOf,
      offset,
    );
    const documentText = "x".repeat(offset) + page.text;
    for (const i of page.items) {
      expect(documentText.slice(i.span.start, i.span.end)).toBe(i.text);
    }
    expect(page.span).toEqual({ start: 1000, end: 1000 + page.text.length });
  });

  it("records position, size and font of each item", () => {
    const [heading] = buildPage(1, [item("Chapter 1", "bold", 24, 72, 700)], fontOf, 0).items;
    expect(heading).toMatchObject({
      text: "Chapter 1",
      x: 72,
      y: 700,
      fontSize: 24,
      fontName: "Helvetica-Bold",
      isBold: true,
    });
  });

  it("reads the font size from the scale of the transform, rounded", () => {
    const rotated = { ...item("a", "r", 0, 0, 0), transform: [0, 12.000000001, -12, 0, 5, 6] };
    expect(buildPage(1, [rotated], fontOf, 0).items[0]?.fontSize).toBe(12);
  });

  it("builds an empty page when there is no text", () => {
    expect(buildPage(4, [], fontOf, 50)).toEqual({
      number: 4,
      text: "",
      span: { start: 50, end: 50 },
      items: [],
    });
  });
});

describe("pickTitle", () => {
  it("uses the title from the PDF's metadata", () => {
    expect(pickTitle({ Title: "  Deep Learning  " }, "/books/dl.pdf")).toBe("Deep Learning");
  });

  it("falls back to the file name without its extension", () => {
    expect(pickTitle({}, "/books/my-book.pdf")).toBe("my-book");
    expect(pickTitle({ Title: "   " }, "/books/my-book.pdf")).toBe("my-book");
    expect(pickTitle(undefined, "C:\\books\\notes.pdf")).toBe("notes");
    expect(pickTitle({ Title: 42 }, "/books/x.pdf")).toBe("x");
  });
});

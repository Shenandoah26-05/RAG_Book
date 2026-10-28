import { highlightResponseSchema } from "@rag-book/api-contract";
import { describe, expect, it } from "vitest";
import { PAGE_SEPARATOR } from "../core/index.js";
import type { Page, ParsedDocument, TextItem } from "../core/index.js";
import { createApp } from "./app.js";
import { BOOK, DOC, fakeServices } from "./api.testing.js";
import { toWireHighlights } from "./highlights.js";

/** An item at a position, 10 points tall unless said otherwise, whose text starts at `start`. */
const item = (
  start: number,
  length: number,
  x: number,
  y: number,
  width: number,
  fontSize = 10,
): TextItem => ({
  text: "x".repeat(length),
  x,
  y,
  width,
  fontSize,
  fontName: "Helvetica",
  isBold: false,
  span: { start, end: start + length },
});

/** A document of pages whose text is as long as their items say, joined as the loader joins them. */
function documentOf(pagesItems: readonly (readonly TextItem[])[]): ParsedDocument {
  let offset = 0;
  const pages: Page[] = pagesItems.map((items, index) => {
    const length = Math.max(0, ...items.map((i) => i.span.end)) - offset;
    const page: Page = {
      number: index + 1,
      text: "x".repeat(length),
      span: { start: offset, end: offset + length },
      items,
    };
    offset += length + PAGE_SEPARATOR.length;
    return page;
  });
  return { ...BOOK, pages, pageCount: pages.length, text: "x".repeat(offset), sections: [] };
}

describe("toWireHighlights", () => {
  it("puts a box over a whole item: from the baseline less the descent, to the ascent above it", () => {
    // font size 10: the box runs from y - 2.5 to y + 9.5, so it is 12 tall
    const doc = documentOf([[item(0, 20, 100, 700, 200)]]);
    expect(toWireHighlights(doc, 0, 20).pages).toEqual([
      { number: 1, boxes: [{ x: 100, y: 697.5, width: 200, height: 12 }] },
    ]);
  });

  it("covers the same share of the width as of the characters", () => {
    // characters 5 to 15 of a 20-character item 200 wide: a quarter in, half the width
    const doc = documentOf([[item(0, 20, 100, 700, 200)]]);
    expect(toWireHighlights(doc, 5, 15).pages[0]?.boxes).toEqual([
      { x: 150, y: 697.5, width: 100, height: 12 },
    ]);
  });

  it("joins the items of a line into one band", () => {
    // two items 50 wide with a 5-point gap, less than a space: one box from 100 to 205
    const doc = documentOf([[item(0, 10, 100, 700, 50), item(10, 10, 155, 700, 50)]]);
    expect(toWireHighlights(doc, 0, 20).pages[0]?.boxes).toEqual([
      { x: 100, y: 697.5, width: 105, height: 12 },
    ]);
  });

  it("keeps separate lines, and separate runs far apart on one line, apart", () => {
    const lines = documentOf([[item(0, 10, 100, 700, 50), item(10, 10, 100, 686, 50)]]);
    expect(toWireHighlights(lines, 0, 20).pages[0]?.boxes).toEqual([
      { x: 100, y: 697.5, width: 50, height: 12 },
      { x: 100, y: 683.5, width: 50, height: 12 },
    ]);
    // a 100-point gap is a column break, not a space
    const columns = documentOf([[item(0, 10, 100, 700, 50), item(10, 10, 250, 700, 50)]]);
    expect(toWireHighlights(columns, 0, 20).pages[0]?.boxes).toHaveLength(2);
  });

  it("covers only the items the range touches", () => {
    const doc = documentOf([
      [item(0, 10, 100, 700, 50), item(10, 10, 100, 686, 50), item(20, 10, 100, 672, 50)],
    ]);
    expect(toWireHighlights(doc, 10, 20).pages[0]?.boxes).toEqual([
      { x: 100, y: 683.5, width: 50, height: 12 },
    ]);
  });

  it("follows a range onto the next page, with each page's own boxes", () => {
    // page 1 holds characters 0-10, the separator 10-12, page 2 holds 12-22
    const doc = documentOf([[item(0, 10, 100, 700, 50)], [item(12, 10, 80, 600, 70)]]);
    const result = toWireHighlights(doc, 5, 18);
    expect(result.pages.map((p) => p.number)).toEqual([1, 2]);
    expect(result.pages[0]?.boxes).toEqual([{ x: 125, y: 697.5, width: 25, height: 12 }]);
    expect(result.pages[1]?.boxes).toEqual([{ x: 80, y: 597.5, width: 42, height: 12 }]);
  });

  it("lists a page that has text but no positions, with no boxes", () => {
    const doc = documentOf([[item(0, 10, 100, 700, 50)]]);
    const noPositions: ParsedDocument = {
      ...doc,
      pages: doc.pages.map((page) => ({ ...page, items: [] })),
    };
    expect(toWireHighlights(noPositions, 0, 10).pages).toEqual([{ number: 1, boxes: [] }]);
  });

  it("has no page for a range that falls only in the gap between pages", () => {
    const doc = documentOf([[item(0, 10, 100, 700, 50)], [item(12, 10, 80, 600, 70)]]);
    expect(toWireHighlights(doc, 10, 12).pages).toEqual([]);
  });

  it("skips items with no width, no characters or no font size", () => {
    const doc = documentOf([
      [item(0, 5, 10, 700, 0), item(5, 0, 10, 700, 20), item(5, 5, 10, 700, 20, 0)],
    ]);
    expect(toWireHighlights(doc, 0, 10).pages).toEqual([{ number: 1, boxes: [] }]);
  });

  it("scales the box with the font size", () => {
    const doc = documentOf([[item(0, 10, 50, 500, 100, 20)]]);
    expect(toWireHighlights(doc, 0, 10).pages[0]?.boxes).toEqual([
      { x: 50, y: 495, width: 100, height: 24 },
    ]);
  });
});

describe("GET /highlights", () => {
  const doc = documentOf([[item(0, 20, 100, 700, 200)]]);
  const setup = () => createApp(fakeServices({ documents: new Map([[DOC, doc]]) }));

  it("answers with the pages and boxes of the passage", async () => {
    const response = await setup().request("/highlights?from=5&to=15");
    expect(response.status).toBe(200);
    expect(highlightResponseSchema.parse(await response.json())).toEqual({
      docId: DOC,
      pages: [{ number: 1, boxes: [{ x: 150, y: 697.5, width: 100, height: 12 }] }],
    });
  });

  it("needs both ends, whole numbers, in order", async () => {
    const app = setup();
    for (const query of [
      "",
      "?from=5",
      "?to=5",
      "?from=a&to=5",
      "?from=-1&to=5",
      "?from=9&to=3",
      "?from=4&to=4",
    ]) {
      expect((await app.request(`/highlights${query}`)).status, query).toBe(400);
    }
  });

  it("refuses a passage that is not a passage: too long, or past the end of the text", async () => {
    const app = setup();
    expect((await app.request("/highlights?from=0&to=20001")).status).toBe(400);
    const past = await app.request(`/highlights?from=0&to=${(doc.text.length + 1).toString()}`);
    expect(past.status).toBe(400);
  });

  it("asks which document when the index holds several, and says when it is not there", async () => {
    const response = await createApp(
      fakeServices({
        documents: new Map([[DOC, doc]]),
        documentIds: [DOC, "00000000-0000-5000-8000-000000000000" as typeof DOC],
      }),
    ).request("/highlights?from=0&to=5");
    expect(response.status).toBe(400);
    expect((await setup().request("/highlights?from=0&to=5&doc=nope")).status).toBe(400);
  });
});

import { describe, expect, it } from "vitest";
import type { ParsedDocument, Section } from "../../core/index.js";
import { makeChunkId } from "../../core/index.js";
import { RagError } from "../../shared/index.js";
import { chunkerFixtures } from "../../testing/chunker-contract.testing.js";
import { makeDocument } from "../../testing/make-document.testing.js";
import { createChunk, pageRangeOf, sectionPathAt } from "./chunk-builder.js";

const fixture = (name: string): ParsedDocument => {
  const found = chunkerFixtures().find((f) => f.name === name);
  if (found === undefined) throw new Error(`no fixture named "${name}"`);
  return found.doc;
};

/** Page 1 is "AAAA BBBB", page 2 is "CCCC DDDD": text is "AAAA BBBB\n\nCCCC DDDD". */
const TWO_PAGES = makeDocument(["AAAA BBBB", "CCCC DDDD"]);

describe("pageRangeOf", () => {
  it("is one page for a span inside a page", () => {
    expect(pageRangeOf(TWO_PAGES, 0, 4)).toEqual({ pageStart: 1, pageEnd: 1 });
    expect(pageRangeOf(TWO_PAGES, 11, 15)).toEqual({ pageStart: 2, pageEnd: 2 });
  });

  it("spans two pages for a span that crosses a page break", () => {
    expect(pageRangeOf(TWO_PAGES, 5, 15)).toEqual({ pageStart: 1, pageEnd: 2 });
  });

  it("includes the last character of a page, and not the break after it", () => {
    // page 1 is characters 0 to 8; the blank line between pages is characters 9 and 10
    expect(pageRangeOf(TWO_PAGES, 5, 9)).toEqual({ pageStart: 1, pageEnd: 1 });
  });

  it("moves a start that is in the break between pages to the next page", () => {
    expect(pageRangeOf(TWO_PAGES, 9, 15)).toEqual({ pageStart: 2, pageEnd: 2 });
  });

  it("moves an end that is in the break between pages to the previous page", () => {
    expect(pageRangeOf(TWO_PAGES, 5, 11)).toEqual({ pageStart: 1, pageEnd: 1 });
  });

  it("ignores pages with no text, and keeps the real page numbers", () => {
    const doc = fixture("a blank page in the middle");
    const third = doc.text.indexOf("Third");
    expect(pageRangeOf(doc, third, third + 5)).toEqual({ pageStart: 3, pageEnd: 3 });
    expect(pageRangeOf(doc, 0, doc.text.length)).toEqual({ pageStart: 1, pageEnd: 3 });
  });

  it("numbers pages by their own number, which need not start at 1", () => {
    const doc = makeDocument(["AAAA", "BBBB"], { firstPageNumber: 5 });
    expect(pageRangeOf(doc, 0, 10)).toEqual({ pageStart: 5, pageEnd: 6 });
  });

  it("falls back to page 1 for a document that has no pages", () => {
    expect(pageRangeOf(makeDocument([]), 0, 1)).toEqual({ pageStart: 1, pageEnd: 1 });
  });
});

describe("sectionPathAt", () => {
  const doc = fixture("sections and subsections over two pages");

  it("is the chapter for text directly in a chapter", () => {
    expect(sectionPathAt(doc.sections, doc.text.indexOf("Alpha"))).toEqual(["Chapter One"]);
  });

  it("goes down to the deepest section", () => {
    expect(sectionPathAt(doc.sections, doc.text.indexOf("Beta"))).toEqual([
      "Chapter One",
      "1.1 Sub",
    ]);
  });

  it("stays in the deepest section across a page break, until the next chapter", () => {
    expect(sectionPathAt(doc.sections, doc.text.indexOf("Delta"))).toEqual([
      "Chapter One",
      "1.1 Sub",
    ]);
    expect(sectionPathAt(doc.sections, doc.text.indexOf("Epsilon"))).toEqual(["Chapter Two"]);
  });

  it("includes a section from the first character of its heading", () => {
    expect(sectionPathAt(doc.sections, doc.text.indexOf("1.1 Sub"))).toEqual([
      "Chapter One",
      "1.1 Sub",
    ]);
    expect(sectionPathAt(doc.sections, doc.text.indexOf("Chapter Two"))).toEqual(["Chapter Two"]);
  });

  it("is empty before the first section and after the last", () => {
    const section: Section = {
      title: "Only",
      level: 1,
      pageStart: 1,
      pageEnd: 1,
      span: { start: 10, end: 20 },
      titleSpan: { start: 10, end: 14 },
      children: [],
    };
    expect(sectionPathAt([section], 9)).toEqual([]);
    expect(sectionPathAt([section], 10)).toEqual(["Only"]);
    expect(sectionPathAt([section], 19)).toEqual(["Only"]);
    expect(sectionPathAt([section], 20)).toEqual([]); // the end of a span is not inside it
  });

  it("is empty when the document has no sections", () => {
    expect(sectionPathAt([], 5)).toEqual([]);
  });
});

describe("createChunk", () => {
  const doc = fixture("sections and subsections over two pages");
  const start = doc.text.indexOf("Beta");
  const end = doc.text.indexOf("Gamma") - 2; // the end of "Beta paragraph text here."

  it("fills in the text, the span, the strategy and the document", () => {
    const chunk = createChunk(doc, "demo", { start, end });
    expect(chunk.text).toBe("Beta paragraph text here.");
    expect(chunk.metadata).toMatchObject({
      docId: doc.id,
      charStart: start,
      charEnd: end,
      strategy: "demo",
    });
  });

  it("works out the page range and the section path from the span", () => {
    const chunk = createChunk(doc, "demo", { start, end });
    expect(chunk.metadata.pageStart).toBe(1);
    expect(chunk.metadata.pageEnd).toBe(1);
    expect(chunk.metadata.sectionPath).toEqual(["Chapter One", "1.1 Sub"]);
  });

  it("covers both pages for a chunk that crosses a page break", () => {
    const chunk = createChunk(doc, "demo", {
      start: doc.text.indexOf("Gamma"),
      end: doc.text.indexOf("Delta") + 5,
    });
    expect(chunk.metadata).toMatchObject({ pageStart: 1, pageEnd: 2 });
  });

  it("gives the id that makeChunkId gives for the same document, strategy, span and text", () => {
    const chunk = createChunk(doc, "demo", { start, end });
    expect(chunk.id).toBe(
      makeChunkId({
        docId: doc.id,
        strategy: "demo",
        charStart: start,
        charEnd: end,
        text: chunk.text,
      }),
    );
  });

  it("gives the same chunk for the same input, and another id for another strategy", () => {
    const a = createChunk(doc, "demo", { start, end });
    expect(createChunk(doc, "demo", { start, end })).toEqual(a);
    expect(createChunk(doc, "other", { start, end }).id).not.toBe(a.id);
  });

  it("accepts a text with the edges trimmed", () => {
    // the span takes in the blank line before and after the paragraph; the text drops it
    const chunk = createChunk(
      doc,
      "demo",
      { start: start - 2, end: end + 2 },
      "Beta paragraph text here.",
    );
    expect(chunk.text).toBe("Beta paragraph text here.");
    expect(chunk.metadata).toMatchObject({ charStart: start - 2, charEnd: end + 2 });
  });

  it("accepts a text with whitespace collapsed", () => {
    const multi = fixture("sections and subsections over two pages");
    const from = multi.text.indexOf("Alpha");
    const to = multi.text.indexOf("1.1 Sub") - 2;
    expect(multi.text.slice(from, to)).toContain("\n"); // the passage has a line break inside
    const chunk = createChunk(
      multi,
      "demo",
      { start: from, end: to },
      multi.text.slice(from, to).replace(/\s+/g, " "),
    );
    expect(chunk.text).toBe("Alpha paragraph first line. Still alpha, second line.");
  });

  it("rejects a text that changes anything but whitespace", () => {
    expect(() => createChunk(doc, "demo", { start, end }, "Beta paragraph text there.")).toThrow(
      RagError,
    );
    expect(() => createChunk(doc, "demo", { start, end }, "Beta paragraph")).toThrow(
      /only in whitespace/,
    );
    expect(() =>
      createChunk(doc, "demo", { start, end }, "Beta paragraph text here. And more"),
    ).toThrow(/only in whitespace/);
  });

  it.each([
    ["starts before the document", { start: -1, end: 5 }],
    ["ends after the document", { start: 0, end: 10_000 }],
    ["is empty", { start: 5, end: 5 }],
    ["ends before it starts", { start: 9, end: 4 }],
    ["has a start that is not a whole number", { start: 1.5, end: 6 }],
  ])("rejects a span that %s", (_name, span) => {
    const error = (() => {
      try {
        createChunk(doc, "demo", span);
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(RagError);
    expect((error as RagError).code).toBe("INVALID_ARGUMENT");
    expect((error as RagError).message).toContain("demo");
  });

  it("rejects a span that holds only whitespace", () => {
    const gap = doc.text.indexOf("\n\n");
    expect(() => createChunk(doc, "demo", { start: gap, end: gap + 2 })).toThrow(/only whitespace/);
  });

  it("does not change the document", () => {
    const before = JSON.stringify(doc);
    createChunk(doc, "demo", { start, end });
    expect(JSON.stringify(doc)).toBe(before);
  });
});

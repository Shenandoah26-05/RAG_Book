import { describe, expect, it } from "vitest";
import type { ParsedDocument, Section } from "../../core/index.js";
import { makeDocument } from "../../testing/make-document.testing.js";
import { FontHeadingDetector } from "./font-heading-detector.js";
import { documentToMarkdown, outline } from "./markdown.js";

const sectionAt = (
  doc: ParsedDocument,
  title: string,
  level: number,
  children: Section[] = [],
): Section => {
  const start = doc.text.indexOf(title);
  return {
    title,
    level,
    pageStart: 1,
    pageEnd: 1,
    span: { start, end: doc.text.length },
    titleSpan: { start, end: start + title.length },
    children,
  };
};

describe("documentToMarkdown", () => {
  it("marks pages and turns headings into # lines", () => {
    const doc = makeDocument(["Chapter One\nfirst body line", "1.1 Sub\nsecond body line"]);
    const sections = [sectionAt(doc, "Chapter One", 1, [sectionAt(doc, "1.1 Sub", 2)])];

    expect(documentToMarkdown({ ...doc, sections })).toBe(
      [
        "<!-- page 1 -->",
        "",
        "# Chapter One",
        "",
        "first body line",
        "",
        "<!-- page 2 -->",
        "",
        "## 1.1 Sub",
        "",
        "second body line",
        "",
      ].join("\n"),
    );
  });

  it("keeps text that comes before the first heading", () => {
    const doc = makeDocument(["Preface line\nChapter One\nbody"]);
    const markdown = documentToMarkdown({ ...doc, sections: [sectionAt(doc, "Chapter One", 1)] });
    expect(markdown).toBe(
      ["<!-- page 1 -->", "", "Preface line", "", "# Chapter One", "", "body", ""].join("\n"),
    );
  });

  it("writes only page markers and text for a document without sections", () => {
    const doc = makeDocument(["one", "two"]);
    expect(documentToMarkdown(doc)).toBe(
      ["<!-- page 1 -->", "", "one", "", "<!-- page 2 -->", "", "two", ""].join("\n"),
    );
  });

  it("marks empty pages too", () => {
    expect(documentToMarkdown(makeDocument(["text", ""]))).toBe(
      ["<!-- page 1 -->", "", "text", "", "<!-- page 2 -->", ""].join("\n"),
    );
  });

  it("uses the heading's own title and drops the heading text from the body", () => {
    const doc = makeDocument(["Introduction to\nRetrieval\nbody"]);
    const section: Section = {
      title: "Introduction to Retrieval",
      level: 1,
      pageStart: 1,
      pageEnd: 1,
      span: { start: 0, end: doc.text.length },
      titleSpan: { start: 0, end: "Introduction to\nRetrieval".length },
      children: [],
    };
    const markdown = documentToMarkdown({ ...doc, sections: [section] });
    expect(markdown).toContain("# Introduction to Retrieval\n\nbody");
    expect(markdown).not.toContain("Introduction to\nRetrieval");
  });

  it("caps heading levels at six", () => {
    const doc = makeDocument(["Deep\nbody"]);
    const markdown = documentToMarkdown({ ...doc, sections: [sectionAt(doc, "Deep", 9)] });
    expect(markdown).toContain("###### Deep");
    expect(markdown).not.toContain("#######");
  });

  it("collapses runs of blank lines and ends with one newline", () => {
    const markdown = documentToMarkdown(makeDocument(["a\n\n\n\nb"]));
    expect(markdown).not.toMatch(/\n{3,}/);
    expect(markdown.endsWith("b\n")).toBe(true);
  });

  it("works on a document whose sections were found by the detector", () => {
    const doc = makeDocument(
      ["Chapter One\nsome ordinary body text on this line, long enough\nmore body text here"],
      {
        fontSizeOf: (line) => (line === "Chapter One" ? 24 : 12),
        isBold: (line) => line === "Chapter One",
      },
    );
    const markdown = documentToMarkdown(new FontHeadingDetector().detect(doc));
    expect(markdown).toContain("# Chapter One");
    expect(markdown).toContain("some ordinary body text on this line, long enough");
  });
});

describe("outline", () => {
  it("lists sections with indentation and page ranges", () => {
    const doc = makeDocument(["x"]);
    const tree: Section[] = [
      {
        ...sectionAt(doc, "x", 1, [{ ...sectionAt(doc, "x", 2), pageStart: 2, pageEnd: 2 }]),
        pageEnd: 3,
      },
    ];
    expect(outline(tree).replaceAll("x  ", "T  ")).toBe(["T  (pp.1-3)", "  T  (p.2)"].join("\n"));
  });

  it("is empty for no sections", () => {
    expect(outline([])).toBe("");
  });
});

import { describe, expect, it } from "vitest";
import { expectConsistent, makeDocument } from "../../testing/make-document.testing.js";
import { makeSectionedDocument } from "../../testing/sectioned-document.testing.js";
import { documentView, sectionSegments, trimSpan } from "./section-segments.js";

describe("trimSpan", () => {
  it("removes whitespace at both edges", () => {
    expect(trimSpan("  ab \n", { start: 0, end: 6 })).toEqual({ start: 2, end: 4 });
  });

  it("returns undefined when only whitespace is left", () => {
    expect(trimSpan(" \n ", { start: 0, end: 3 })).toBeUndefined();
  });
});

describe("sectionSegments", () => {
  it("gives one piece for a document with no sections", () => {
    const doc = makeDocument(["one two", "three"]);
    expect(sectionSegments(doc)).toEqual([{ start: 0, end: doc.text.length }]);
  });

  it("gives nothing for an empty document", () => {
    expect(sectionSegments(makeDocument([""]))).toEqual([]);
  });

  it("cuts at every section, keeping the preamble and each section's own text", () => {
    const doc = makeSectionedDocument();
    const texts = sectionSegments(doc).map((s) => doc.text.slice(s.start, s.end));
    expect(texts).toEqual([
      "Preface words",
      "Chapter One\nalpha beta gamma",
      "1.1 Sub\ndelta epsilon",
      "Chapter Two\nzeta eta",
    ]);
  });

  it("covers every non-whitespace character exactly once", () => {
    const doc = makeSectionedDocument();
    const covered = new Array<number>(doc.text.length).fill(0);
    for (const { start, end } of sectionSegments(doc)) {
      for (let i = start; i < end; i += 1) {
        covered[i] = (covered[i] ?? 0) + 1;
      }
    }
    for (let i = 0; i < doc.text.length; i += 1) {
      // whitespace inside a piece is covered too; only the edges between pieces are trimmed away
      if (!/\s/.test(doc.text.charAt(i))) {
        expect(covered[i]).toBe(1);
      }
    }
  });
});

describe("documentView", () => {
  const doc = makeSectionedDocument();

  it("rebases the text, pages and items onto the span", () => {
    const start = doc.text.indexOf("alpha");
    const end = doc.text.indexOf("delta") + "delta".length;
    const view = documentView(doc, { start, end });

    expect(view.text).toBe("alpha beta gamma\n\n1.1 Sub\ndelta");
    expect(view.sections).toEqual([]);
    expect(view.pages.map((p) => [p.number, p.text])).toEqual([
      [1, "alpha beta gamma"],
      [2, "1.1 Sub\ndelta"],
    ]);
    expectConsistent(view);
  });

  it("drops pages outside the span", () => {
    const start = doc.text.indexOf("zeta");
    const view = documentView(doc, { start, end: doc.text.length });
    expect(view.pages.map((p) => p.number)).toEqual([2]);
    expect(view.pageCount).toBe(1);
  });
});

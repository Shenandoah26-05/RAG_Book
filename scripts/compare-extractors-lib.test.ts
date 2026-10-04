import { describe, expect, it } from "vitest";
import type { ParsedDocument, TextItem } from "../src/core/index.js";
import { makeDocId } from "../src/shared/index.js";
import {
  compareDocuments,
  firstDifference,
  normalizeWhitespace,
  summarize,
} from "./compare-extractors-lib.js";

function item(text: string, fontSize: number, isBold = false, fontName = "F"): TextItem {
  return { text, x: 0, y: 0, width: 0, fontSize, fontName, isBold, span: { start: 0, end: 0 } };
}

function doc(pageTexts: readonly string[], items: readonly TextItem[][] = []): ParsedDocument {
  const pages = pageTexts.map((text, i) => ({
    number: i + 1,
    text,
    span: { start: 0, end: text.length },
    items: items[i] ?? [],
  }));
  return {
    id: makeDocId("x"),
    title: "t",
    pageCount: pages.length,
    sha256: "x",
    text: pageTexts.join("\n\n"),
    pages,
    sections: [],
  };
}

describe("normalizeWhitespace", () => {
  it("collapses runs of whitespace and trims", () => {
    expect(normalizeWhitespace("  a \n\n b\t c  ")).toBe("a b c");
  });
});

describe("firstDifference", () => {
  it("is undefined for equal strings", () => {
    expect(firstDifference("same", "same")).toBeUndefined();
  });

  it("finds the first differing index and shows both sides", () => {
    expect(firstDifference("hello world", "hello_world", 4)).toEqual({
      index: 5,
      a: JSON.stringify("ello wor"),
      b: JSON.stringify("ello_wor"),
    });
  });

  it("handles one string being a prefix of the other", () => {
    expect(firstDifference("abc", "abcd")?.index).toBe(3);
    expect(firstDifference("", "x")?.index).toBe(0);
  });

  it("makes whitespace visible", () => {
    expect(firstDifference("a\nb", "a b")?.a).toBe(JSON.stringify("a\nb"));
  });
});

describe("summarize", () => {
  it("counts pages, words, items, bold items and fonts", () => {
    const d = doc(
      ["Hello brave world", "", "Bye"],
      [[item("Hello", 24, true, "Bold"), item("brave world", 12)], [], [item("Bye", 12)]],
    );
    expect(summarize(d)).toMatchObject({
      pages: 3,
      emptyPages: 1,
      words: 4,
      items: 3,
      boldItems: 1,
      fontNames: ["Bold", "F"],
    });
  });

  it("ranks font sizes by how much text uses them", () => {
    const d = doc(["x"], [[item("title", 24), item("a long paragraph of body text", 12)]]);
    expect(summarize(d).topSizes).toEqual([
      [12, 29],
      [24, 5],
    ]);
  });

  it("copes with an empty document", () => {
    expect(summarize(doc([]))).toMatchObject({ pages: 0, words: 0, items: 0 });
  });
});

describe("compareDocuments", () => {
  it("reports identical documents", () => {
    const result = compareDocuments(doc(["a", "b"]), doc(["a", "b"]));
    expect(result).toEqual({
      pages: 2,
      identical: 2,
      identicalIgnoringWhitespace: 2,
      differing: [],
    });
  });

  it("separates whitespace-only differences from real ones", () => {
    const a = doc(["one two", "three four", "same"]);
    const b = doc(["one  two", "three FOUR", "same"]);
    const result = compareDocuments(a, b);

    expect(result.identical).toBe(1);
    expect(result.identicalIgnoringWhitespace).toBe(2);
    expect(result.differing.map((d) => [d.page, d.whitespaceOnly])).toEqual([
      [1, true],
      [2, false],
    ]);
  });

  it("counts extra pages in the longer document as differences", () => {
    const result = compareDocuments(doc(["a"]), doc(["a", "b"]));
    expect(result.pages).toBe(2);
    expect(result.differing.map((d) => d.page)).toEqual([2]);
  });
});

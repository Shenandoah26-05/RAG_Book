import { describe, expect, it } from "vitest";
import { expectConsistent, makeDocument, pageTexts } from "../../testing/make-document.testing.js";
import { PageNumberCleaner } from "./page-number-cleaner.js";

const EN_DASH = String.fromCodePoint(0x2013);

const clean = (pages: readonly string[], firstPageNumber = 1): string[] => {
  const cleaned = new PageNumberCleaner().clean(makeDocument(pages, { firstPageNumber }));
  expectConsistent(cleaned);
  return pageTexts(cleaned);
};

describe("PageNumberCleaner: before and after", () => {
  it("removes a number at the bottom of each page", () => {
    expect(clean(["Intro\n\n1", "More text\n\n2", "Even more\n\n3"])).toEqual([
      "Intro",
      "More text",
      "Even more",
    ]);
  });

  it("removes a number at the top of each page", () => {
    expect(clean(["1\nIntro", "2\nMore text", "3\nEven more"])).toEqual([
      "Intro",
      "More text",
      "Even more",
    ]);
  });

  it("follows the printed numbering when it differs from the PDF page numbers", () => {
    // PDF pages 1 to 3 are printed pages 5 to 7
    expect(clean(["Intro\n5", "More\n6", "Last\n7"])).toEqual(["Intro", "More", "Last"]);
  });

  it("removes numbers on only some pages, when they follow the pages", () => {
    expect(clean(["Intro\n1", "Chapter title page", "Body\n3", "Body\n4"])).toEqual([
      "Intro",
      "Chapter title page",
      "Body",
      "Body",
    ]);
  });

  it("removes 'Page N', 'Page N of M', 'N / M' and dashed forms", () => {
    expect(
      clean(["a\nPage 1", "b\nPage 2 of 9", "c\n3 / 9", `d\n${EN_DASH} 4 ${EN_DASH}`, "e\n- 5 -"]),
    ).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("removes roman numerals in the front matter", () => {
    expect(clean(["Preface\ni", "More preface\nii", "Still preface\niii"])).toEqual([
      "Preface",
      "More preface",
      "Still preface",
    ]);
  });

  it("handles front matter and main text numbered separately", () => {
    // PDF pages 2 and 3 are printed ii and iii; PDF pages 4 and 5 restart at 1 and 2
    expect(clean(["Preface\nii", "More\niii", "Chapter\n1", "Text\n2"], 2)).toEqual([
      "Preface",
      "More",
      "Chapter",
      "Text",
    ]);
  });

  it("keeps a number in the middle of a page", () => {
    const body = "line\nline\nline\n7\nline\nline\nline";
    expect(clean([body, body, body])).toEqual([body, body, body]);
  });

  it("keeps numbers that do not follow the pages", () => {
    // 7 on page 1 and 7 on page 2: different offsets, so not page numbers
    expect(clean(["Table of values\n7", "More values\n7", "Closing words"])).toEqual([
      "Table of values\n7",
      "More values\n7",
      "Closing words",
    ]);
  });

  it("keeps a lone number when no other page agrees with it", () => {
    expect(clean(["Chapter text\n3", "No number here", "Nor here"])).toEqual([
      "Chapter text\n3",
      "No number here",
      "Nor here",
    ]);
  });

  it("keeps numbers that are part of a sentence", () => {
    expect(
      clean(["Chapter 1 begins\ntext", "Chapter 2 begins\ntext", "Chapter 3 begins\ntext"]),
    ).toEqual(["Chapter 1 begins\ntext", "Chapter 2 begins\ntext", "Chapter 3 begins\ntext"]);
  });

  it("keeps ordinary words that happen to be roman numerals when they do not follow the pages", () => {
    expect(clean(["Intro\nmix", "More\nmix", "Last\nmix"])).toEqual([
      "Intro\nmix",
      "More\nmix",
      "Last\nmix",
    ]);
  });
});

describe("PageNumberCleaner: documents", () => {
  it("returns the same document when there is nothing to remove", () => {
    const doc = makeDocument(["no numbers", "none here"]);
    expect(new PageNumberCleaner().clean(doc)).toBe(doc);
  });

  it("drops the page-number items and keeps the others", () => {
    const cleaned = new PageNumberCleaner().clean(makeDocument(["Title\nbody\n1", "Next\n2"]));
    expect(cleaned.pages[0]?.items.map((i) => i.text)).toEqual(["Title", "body"]);
    expect(cleaned.pages[1]?.items.map((i) => i.text)).toEqual(["Next"]);
  });

  it("copes with empty pages", () => {
    expect(clean(["Text\n1", "", "Text\n3", "Text\n4"])).toEqual(["Text", "", "Text", "Text"]);
  });

  it("is named for the config value", () => {
    expect(new PageNumberCleaner().name).toBe("page-numbers");
  });
});

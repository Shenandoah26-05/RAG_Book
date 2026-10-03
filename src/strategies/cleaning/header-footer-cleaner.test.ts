import { describe, expect, it } from "vitest";
import { HeaderFooterCleaner } from "./header-footer-cleaner.js";
import { expectConsistent, makeDocument, pageTexts } from "./make-document.testing.js";

const clean = (pages: readonly string[]): string[] => {
  const cleaned = new HeaderFooterCleaner().clean(makeDocument(pages));
  expectConsistent(cleaned);
  return pageTexts(cleaned);
};

describe("HeaderFooterCleaner: before and after", () => {
  it("removes a header repeated on every page", () => {
    expect(
      clean([
        "The RAG Handbook\nBody one",
        "The RAG Handbook\nBody two",
        "The RAG Handbook\nBody three",
      ]),
    ).toEqual(["Body one", "Body two", "Body three"]);
  });

  it("removes a footer repeated on every page", () => {
    expect(
      clean(["Body one\nAcme Press", "Body two\nAcme Press", "Body three\nAcme Press"]),
    ).toEqual(["Body one", "Body two", "Body three"]);
  });

  it("treats lines that differ only in their digits as the same line", () => {
    expect(
      clean(["Body one\nPage 1 of 9", "Body two\nPage 2 of 9", "Body three\nPage 3 of 9"]),
    ).toEqual(["Body one", "Body two", "Body three"]);
    expect(clean(["Chapter 1\nBody one", "Chapter 2\nBody two", "Chapter 3\nBody three"])).toEqual([
      "Body one",
      "Body two",
      "Body three",
    ]);
  });

  it("ignores differences in case and spacing", () => {
    expect(clean(["THE  HANDBOOK\nOne", "The Handbook\nTwo", "the handbook\nThree"])).toEqual([
      "One",
      "Two",
      "Three",
    ]);
  });

  it("removes a header and a footer together", () => {
    expect(clean(["Head\nOne\nFoot", "Head\nTwo\nFoot", "Head\nThree\nFoot"])).toEqual([
      "One",
      "Two",
      "Three",
    ]);
  });

  it("removes headers that alternate between even and odd pages", () => {
    const pages = [
      "Chapter One\nBody a",
      "The Book Title\nBody b",
      "Chapter One\nBody c",
      "The Book Title\nBody d",
      "Chapter One\nBody e",
      "The Book Title\nBody f",
    ];
    // each header is on exactly half of the pages, but on every page of its own parity
    expect(clean(pages)).toEqual(["Body a", "Body b", "Body c", "Body d", "Body e", "Body f"]);
  });

  it("removes a header that is missing from a minority of pages", () => {
    expect(clean(["Head\nOne", "Head\nTwo", "Head\nThree", "Chapter opener\nFour"])).toEqual([
      "One",
      "Two",
      "Three",
      "Chapter opener\nFour",
    ]);
  });

  it("keeps a line that repeats on only some pages", () => {
    const pages = ["Note\nOne", "Note\nTwo", "Three", "Four", "Five"];
    expect(clean(pages)).toEqual(pages);
  });

  it("keeps a repeated line that is in the middle of the page", () => {
    // only the middle line repeats; the lines around it are different on every page
    const pages = [
      "alpha\nbeta\ngamma\nrepeated line\ndelta\nepsilon\nzeta",
      "eta\ntheta\niota\nrepeated line\nkappa\nlambda\nmu",
      "nu\nxi\nomicron\nrepeated line\npi\nrho\nsigma",
    ];
    expect(clean(pages)).toEqual(pages);
  });

  it("keeps ordinary body lines that do not repeat", () => {
    const pages = ["Alpha\nBeta\nGamma", "Delta\nEpsilon\nZeta", "Eta\nTheta\nIota"];
    expect(clean(pages)).toEqual(pages);
  });

  it("does nothing on a document with fewer than three pages with text", () => {
    const doc = makeDocument(["Head\nOne", "Head\nTwo"]);
    expect(new HeaderFooterCleaner().clean(doc)).toBe(doc);
    const withBlank = makeDocument(["Head\nOne", "", "Head\nTwo"]);
    expect(new HeaderFooterCleaner().clean(withBlank)).toBe(withBlank);
  });
});

describe("HeaderFooterCleaner: documents", () => {
  it("returns the same document when there is nothing to remove", () => {
    const doc = makeDocument(["One\nAlpha", "Two\nBeta", "Three\nGamma"]);
    expect(new HeaderFooterCleaner().clean(doc)).toBe(doc);
  });

  it("drops the header and footer items and keeps the body items with their font", () => {
    const doc = makeDocument(
      ["Head\nTitle one\nFoot", "Head\nTitle two\nFoot", "Head\nTitle three\nFoot"],
      {
        fontSizeOf: (line) => (line.startsWith("Title") ? 24 : 9),
        isBold: (line) => line.startsWith("Title"),
      },
    );
    const cleaned = new HeaderFooterCleaner().clean(doc);

    expect(cleaned.pages[0]?.items).toHaveLength(1);
    expect(cleaned.pages[0]?.items[0]).toMatchObject({
      text: "Title one",
      fontSize: 24,
      isBold: true,
    });
    expectConsistent(cleaned);
  });

  it("is named for the config value", () => {
    expect(new HeaderFooterCleaner().name).toBe("headers-footers");
  });
});

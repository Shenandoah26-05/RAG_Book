import { describe, expect, it } from "vitest";
import { DehyphenateCleaner } from "./dehyphenate-cleaner.js";
import { expectConsistent, makeDocument, pageTexts } from "../../testing/make-document.testing.js";

const HYPHEN = String.fromCodePoint(0x2010);

const clean = (text: string): string => {
  const cleaned = new DehyphenateCleaner().clean(makeDocument([text]));
  expectConsistent(cleaned);
  return cleaned.pages[0]?.text ?? "";
};

describe("DehyphenateCleaner: before and after", () => {
  it.each([
    ["joins a word split at a line break", "the vec-\ntors are", "the vectors are"],
    ["joins after a short first part", "co-\noperate", "cooperate"],
    ["joins when there are spaces after the hyphen", "vec- \ntors", "vectors"],
    ["joins a typographic hyphen", `vec${HYPHEN}\ntors`, "vectors"],
    ["joins several splits on one page", "vec-\ntors and em-\nbeddings", "vectors and embeddings"],
    ["keeps an ordinary hyphenated word", "a well-known fact", "a well-known fact"],
    ["keeps a hyphen when the next line starts with a capital", "Anglo-\nSaxon", "Anglo-\nSaxon"],
    ["keeps a hyphen when the next line starts with a digit", "range 10-\n20", "range 10-\n20"],
    ["keeps a hyphen after a single letter", "x-\nray", "x-\nray"],
    [
      "keeps a hyphen after a space (a dash, not a split word)",
      "wait -\nthen go",
      "wait -\nthen go",
    ],
    ["keeps a double hyphen", "wait--\nthen go", "wait--\nthen go"],
    ["keeps a hyphen that is not at a line end", "mid-word text", "mid-word text"],
    ["keeps a hyphen at the very end of the page", "ends with vec-", "ends with vec-"],
    ["leaves text with no hyphens alone", "plain\ntext", "plain\ntext"],
  ])("%s", (_name, before, after) => {
    expect(clean(before)).toBe(after);
  });

  it("joins words with accented letters on either side", () => {
    const e = String.fromCodePoint(0xe9);
    expect(clean(`caf${e}-\nine`)).toBe(`caf${e}ine`);
    expect(clean(`vec-\n${e}tors`)).toBe(`vec${e}tors`);
  });
});

describe("DehyphenateCleaner: documents", () => {
  it("returns the same document when there is nothing to join", () => {
    const doc = makeDocument(["no splits here", "none here either"]);
    expect(new DehyphenateCleaner().clean(doc)).toBe(doc);
  });

  it("joins the two halves of a word that are separate text items, and keeps both items", () => {
    const doc = makeDocument(["Embeddings turn sentences into vec-\ntors that can be compared."]);
    const cleaned = new DehyphenateCleaner().clean(doc);

    expect(pageTexts(cleaned)).toEqual([
      "Embeddings turn sentences into vectors that can be compared.",
    ]);
    expect(cleaned.pages[0]?.items.map((i) => i.text)).toEqual([
      "Embeddings turn sentences into vec",
      "tors that can be compared.",
    ]);
    expectConsistent(cleaned);
  });

  it("does not join a word split across a page break (documented limit)", () => {
    const doc = makeDocument(["ends with vec-", "tors starts here"]);
    expect(new DehyphenateCleaner().clean(doc)).toBe(doc);
  });

  it("cleans every page independently", () => {
    const doc = makeDocument(["a vec-\ntor", "b em-\nbed"]);
    expect(pageTexts(new DehyphenateCleaner().clean(doc))).toEqual(["a vector", "b embed"]);
  });

  it("is named for the config value", () => {
    expect(new DehyphenateCleaner().name).toBe("dehyphenate");
  });
});

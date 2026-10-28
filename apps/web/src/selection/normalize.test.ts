import { MAX_SELECTION_CHARS } from "@rag-book/api-contract";
import { describe, expect, it } from "vitest";
import { normalizeSelection } from "./normalize.js";

describe("normalizeSelection", () => {
  it("makes the lines of a page one line of words", () => {
    expect(normalizeSelection("Embeddings turn\nsentences into\n  vectors.")).toEqual({
      text: "Embeddings turn sentences into vectors.",
      truncated: false,
    });
  });

  it("joins a word the page split with a hyphen at the end of a line", () => {
    expect(
      normalizeSelection("Embeddings turn sentences into vec-\ntors that can be compared."),
    ).toEqual({
      text: "Embeddings turn sentences into vectors that can be compared.",
      truncated: false,
    });
    expect(normalizeSelection("a long compar-  \r\n  ison of two")?.text).toBe(
      "a long comparison of two",
    );
  });

  it("leaves a real dash or a hyphen before a capital or a number alone", () => {
    // `state-of-the-art` and `Anglo-\nSaxon` are not words broken by the layout
    expect(normalizeSelection("a well-\nKnown thing")?.text).toBe("a well- Known thing");
    expect(normalizeSelection("pages 3-\n4 and 5")?.text).toBe("pages 3- 4 and 5");
    expect(normalizeSelection("state-of-the-art models")?.text).toBe("state-of-the-art models");
  });

  it("removes soft hyphens", () => {
    expect(normalizeSelection("com­parison")?.text).toBe("comparison");
  });

  it("squeezes tabs and runs of spaces, and trims", () => {
    expect(normalizeSelection("  a \t\t b   c \n")?.text).toBe("a b c");
  });

  it("is undefined for a selection of only whitespace", () => {
    expect(normalizeSelection("")).toBeUndefined();
    expect(normalizeSelection(" \n\t ­ ")).toBeUndefined();
  });

  it("keeps a passage of exactly the longest allowed size whole", () => {
    expect(normalizeSelection("x".repeat(MAX_SELECTION_CHARS))).toEqual({
      text: "x".repeat(MAX_SELECTION_CHARS),
      truncated: false,
    });
  });

  it("cuts a longer passage at the last space before the limit, and says it was cut", () => {
    const words = "word ".repeat(600); // 3000 characters
    const result = normalizeSelection(words);
    expect(result?.truncated).toBe(true);
    expect(result?.text.length).toBeLessThanOrEqual(MAX_SELECTION_CHARS);
    // no word is split: it ends on a whole "word"
    expect(result?.text.endsWith("word")).toBe(true);
    expect(result?.text.length).toBeGreaterThan(MAX_SELECTION_CHARS - 10);
  });

  it("cuts a single enormous word where the limit is, for it has no space", () => {
    const result = normalizeSelection("y".repeat(MAX_SELECTION_CHARS + 300));
    expect(result).toEqual({ text: "y".repeat(MAX_SELECTION_CHARS), truncated: true });
  });
});

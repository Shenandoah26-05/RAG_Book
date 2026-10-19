import { describe, expect, it } from "vitest";
import { analyze, ENGLISH_STOPWORDS } from "./analyzer.js";

describe("analyze", () => {
  it("lowercases and strips punctuation, keeping order and repeats", () => {
    expect(analyze("The Cat, the CAT; and... a dog!")).toEqual([
      "the",
      "cat",
      "the",
      "cat",
      "and",
      "a",
      "dog",
    ]);
  });

  it("drops stopwords when given a set, and only then", () => {
    const stop = new Set(ENGLISH_STOPWORDS);
    expect(analyze("The cat sat on the mat", stop)).toEqual(["cat", "sat", "mat"]);
    expect(analyze("The cat sat on the mat")).toHaveLength(6);
  });

  it("joins apostrophes and splits hyphens and dots", () => {
    expect(analyze("don't DON’T")).toEqual(["dont", "dont"]);
    expect(analyze("state-of-the-art")).toEqual(["state", "of", "the", "art"]);
    expect(analyze("section 3.2")).toEqual(["section", "3", "2"]);
  });

  it("keeps accents and letters of any script, and folds compatibility forms", () => {
    expect(analyze("Café naïve")).toEqual(["café", "naïve"]);
    expect(analyze("日本語 テスト")).toEqual(["日本語", "テスト"]);
    expect(analyze("ﬁnal")).toEqual(["final"]);
  });

  it("gives nothing for text without letters or digits", () => {
    expect(analyze("")).toEqual([]);
    expect(analyze(" ,.;!? — ")).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import { applyEdits } from "./page-edits.js";
import { edgeLines, removeLines, splitLines } from "./lines.js";

const without = (text: string, ...indexes: number[]): string => {
  const lines = splitLines(text);
  const chosen = indexes.map((i) => lines[i]).filter((l) => l !== undefined);
  return applyEdits(text, removeLines(text, chosen)).text;
};

describe("splitLines", () => {
  it("gives each line its offsets", () => {
    expect(splitLines("ab\n\ncde")).toEqual([
      { index: 0, start: 0, end: 2, text: "ab" },
      { index: 1, start: 3, end: 3, text: "" },
      { index: 2, start: 4, end: 7, text: "cde" },
    ]);
  });

  it("treats an empty text as one empty line", () => {
    expect(splitLines("")).toEqual([{ index: 0, start: 0, end: 0, text: "" }]);
  });
});

describe("edgeLines", () => {
  const texts = (text: string, count: number): string[] =>
    edgeLines(splitLines(text), count).map((l) => l.text);

  it("takes the first and last lines that have text, skipping blank ones", () => {
    expect(texts("\n\nA\n\nB\nC\nD\nE\nF\n\n", 2)).toEqual(["A", "B", "E", "F"]);
  });

  it("does not list a line twice when the page is short", () => {
    expect(texts("A\nB", 3)).toEqual(["A", "B"]);
    expect(texts("only", 3)).toEqual(["only"]);
    expect(texts("", 3)).toEqual([]);
  });
});

describe("removeLines", () => {
  it("removes a middle line with its line break", () => {
    expect(without("a\nb\nc", 1)).toBe("a\nc");
  });

  it("removes the first line", () => {
    expect(without("a\nb\nc", 0)).toBe("b\nc");
  });

  it("removes the last line together with the break before it", () => {
    expect(without("a\nb\nc", 2)).toBe("a\nb");
  });

  it("removes neighbouring lines as one edit", () => {
    expect(without("a\nb\nc\nd", 1, 2)).toBe("a\nd");
    expect(without("a\nb\nc\nd", 2, 3)).toBe("a\nb");
    expect(without("a\nb\nc\nd", 0, 3)).toBe("b\nc");
    expect(removeLines("a\nb\nc\nd", splitLines("a\nb\nc\nd").slice(1, 3))).toHaveLength(1);
  });

  it("takes the blank lines next to a line removed at the end of the page", () => {
    expect(without("a\nb\n\n\nc", 4)).toBe("a\nb");
    expect(without("a\n\n1", 2)).toBe("a");
  });

  it("takes the blank lines next to a line removed at the start of the page", () => {
    expect(without("1\n\n\nb\nc", 0)).toBe("b\nc");
  });

  it("keeps blank lines around a line removed from the middle", () => {
    expect(without("a\n\nx\n\nb", 2)).toBe("a\n\n\nb");
  });

  it("removes separate lines separately", () => {
    expect(without("a\nb\nc\nd\ne", 0, 2, 4)).toBe("b\nd");
  });

  it("removes every line", () => {
    expect(without("a\nb", 0, 1)).toBe("");
    expect(without("only", 0)).toBe("");
  });

  it("does nothing when there is nothing to remove", () => {
    expect(removeLines("a\nb", [])).toEqual([]);
  });
});

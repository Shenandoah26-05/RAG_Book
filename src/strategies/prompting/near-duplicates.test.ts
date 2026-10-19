import { describe, expect, it } from "vitest";
import { removeNearDuplicates, textSimilarity } from "./near-duplicates.js";

describe("textSimilarity", () => {
  it("is 1 for the same text, ignoring case and spacing", () => {
    expect(textSimilarity("The cat sat on the mat", "the  cat sat\non the MAT")).toBe(1);
  });

  it("is 0 for texts with nothing in common", () => {
    expect(textSimilarity("alpha beta gamma delta", "one two three four")).toBe(0);
  });

  it("is low for chunks that only overlap at the edges", () => {
    const a = "w1 w2 w3 w4 w5 w6 w7 w8 w9 w10";
    const b = "w9 w10 w11 w12 w13 w14 w15 w16 w17 w18";
    expect(textSimilarity(a, b)).toBeLessThan(0.2);
  });

  it("compares short texts as a whole", () => {
    expect(textSimilarity("hi there", "hi there")).toBe(1);
    expect(textSimilarity("hi there", "bye now")).toBe(0);
  });
});

describe("removeNearDuplicates", () => {
  const base = "Embeddings map text to vectors so that similar meanings sit close together";

  it("keeps the first of two near-copies", () => {
    const items = [base, `${base} indeed`, "A different passage about keyword search and scoring"];
    const { kept, duplicates } = removeNearDuplicates(items, (t) => t, 0.7);
    expect(kept).toEqual([items[0], items[2]]);
    expect(duplicates).toEqual([items[1]]);
  });

  it("keeps everything when nothing is similar", () => {
    const items = ["one two three four", "five six seven eight"];
    expect(removeNearDuplicates(items, (t) => t, 0.8).duplicates).toEqual([]);
  });

  it("compares against kept items, not only the previous one", () => {
    const { kept } = removeNearDuplicates(
      [base, "other words entirely here now", base],
      (t) => t,
      0.8,
    );
    expect(kept).toHaveLength(2);
  });
});

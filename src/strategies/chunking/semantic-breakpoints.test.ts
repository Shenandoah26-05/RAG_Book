import { describe, expect, it } from "vitest";
import { findBreakpoints, neighbourSimilarities, percentile } from "./semantic-breakpoints.js";

const v = (...values: number[]): Float32Array => Float32Array.from(values);

describe("neighbourSimilarities", () => {
  it("gives n - 1 values for n vectors, and none for fewer than two", () => {
    expect(neighbourSimilarities([v(1, 0), v(1, 0), v(0, 1)])).toEqual([
      expect.closeTo(1),
      expect.closeTo(0),
    ]);
    expect(neighbourSimilarities([v(1, 0)])).toEqual([]);
    expect(neighbourSimilarities([])).toEqual([]);
  });
});

describe("percentile", () => {
  it("interpolates between sorted values, computed by hand", () => {
    // sorted 1 2 3 4: the 50th percentile sits at position 1.5, between 2 and 3
    expect(percentile([4, 1, 3, 2], 50)).toBeCloseTo(2.5);
    expect(percentile([4, 1, 3, 2], 0)).toBe(1);
    expect(percentile([4, 1, 3, 2], 100)).toBe(4);
    expect(percentile([5], 30)).toBe(5);
  });
});

describe("findBreakpoints", () => {
  const similarities = [0.9, 0.2, 0.8, 0.1, 0.7];

  it("breaks strictly below a threshold", () => {
    expect(findBreakpoints(similarities, { kind: "threshold", value: 0.5 })).toEqual([
      false,
      true,
      false,
      true,
      false,
    ]);
    expect(findBreakpoints([0.5], { kind: "threshold", value: 0.5 })).toEqual([false]);
  });

  it("breaks at the lowest percent of similarities for a percentile", () => {
    // 40th percentile of [0.1 0.2 0.7 0.8 0.9] is at position 1.6: 0.2 + 0.6 * 0.5 = 0.5
    expect(findBreakpoints(similarities, { kind: "percentile", value: 40 })).toEqual([
      false,
      true,
      false,
      true,
      false,
    ]);
  });

  it("percentile 0 means no breaks, and 100 means break everywhere", () => {
    expect(findBreakpoints(similarities, { kind: "percentile", value: 0 })).toEqual(
      similarities.map(() => false),
    );
    expect(findBreakpoints(similarities, { kind: "percentile", value: 100 })).toEqual(
      similarities.map(() => true),
    );
  });

  it("gives nothing for no similarities", () => {
    expect(findBreakpoints([], { kind: "percentile", value: 50 })).toEqual([]);
  });
});

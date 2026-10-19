import { describe, expect, it } from "vitest";
import { RagError } from "../../shared/index.js";
import { minMaxScale, mmrOrder } from "./mmr.js";

describe("minMaxScale", () => {
  it("maps the lowest to 0, the highest to 1 and the rest in proportion", () => {
    expect(minMaxScale([10, 9, 6, 2])).toEqual([1, 0.875, 0.5, 0]);
    expect(minMaxScale([-3, 0, 3])).toEqual([0, 0.5, 1]);
  });

  it("gives 1 to everything when all scores are equal, and nothing for nothing", () => {
    expect(minMaxScale([4, 4, 4])).toEqual([1, 1, 1]);
    expect(minMaxScale([7])).toEqual([1]);
    expect(minMaxScale([])).toEqual([]);
  });
});

/**
 * Four items, worked out by hand. Item 1 is a copy of item 0; item 3 leans towards both 0 and 2.
 *
 *   relevance:  0: 1.000   1: 0.875   2: 0.500   3: 0.000     (scores 10, 9, 6, 2 scaled)
 *   similarity: 0-1: 1.0   0-2: 0.0   0-3: 0.6   1-2: 0.0   1-3: 0.6   2-3: 0.8
 *
 * With lambda = 0.5, value = 0.5 * relevance - 0.5 * (closest chosen item):
 *   pick 1: nothing chosen, so value = 0.5 * relevance: 0.500, 0.4375, 0.250, 0.000  -> item 0
 *   pick 2: item 1: 0.4375 - 0.5 * 1.0 = -0.0625
 *           item 2: 0.2500 - 0.5 * 0.0 =  0.2500   <- best
 *           item 3: 0.0000 - 0.5 * 0.6 = -0.3000
 *   pick 3: item 1: closest is max(1.0, 0.0) = 1.0:   -0.0625   <- best
 *           item 3: closest is max(0.6, 0.8) = 0.8:   -0.4000
 * So the order is 0, 2, 1: the copy of item 0 is pushed behind the different item 2, although
 * it is more relevant.
 */
const RELEVANCE = [1, 0.875, 0.5, 0];
const SIMILARITY = [
  [1, 1, 0, 0.6],
  [1, 1, 0, 0.6],
  [0, 0, 1, 0.8],
  [0.6, 0.6, 0.8, 1],
];
const similar = (i: number, j: number): number => SIMILARITY[i]?.[j] ?? 0;

describe("mmrOrder: the hand-worked example", () => {
  it("lambda 0.5 puts the copy behind the different item", () => {
    expect(mmrOrder(RELEVANCE, similar, 3, 0.5)).toEqual([0, 2, 1]);
  });

  it("lambda 1 gives the items in order of relevance", () => {
    expect(mmrOrder(RELEVANCE, similar, 4, 1)).toEqual([0, 1, 2, 3]);
  });

  it("lambda 0 ignores relevance and adds whatever is least like the chosen", () => {
    // pick 1: every value is 0, the lower index wins -> 0. Then closest to 0: item 1: 1.0,
    // item 2: 0.0, item 3: 0.6 -> item 2. Then item 1: max(1.0, 0.0) = 1.0, item 3: max(0.6, 0.8) = 0.8
    // -> item 3, and last item 1.
    expect(mmrOrder(RELEVANCE, similar, 4, 0)).toEqual([0, 2, 3, 1]);
  });

  it("returns only k, and all of them when k is larger", () => {
    expect(mmrOrder(RELEVANCE, similar, 1, 0.5)).toEqual([0]);
    expect(mmrOrder(RELEVANCE, similar, 10, 0.5)).toHaveLength(4);
  });
});

describe("mmrOrder: rules", () => {
  it("decides ties by the lower index", () => {
    expect(mmrOrder([1, 1, 1], () => 0, 3, 0.5)).toEqual([0, 1, 2]);
  });

  it("gives nothing for no items", () => {
    expect(mmrOrder([], () => 0, 3, 0.5)).toEqual([]);
  });

  it("asks for each pair at most once", () => {
    const asked = new Set<string>();
    let calls = 0;
    mmrOrder(
      [4, 3, 2, 1, 0].map((x) => x / 4),
      (i, j) => {
        calls += 1;
        asked.add(`${Math.min(i, j).toString()}-${Math.max(i, j).toString()}`);
        return 0.1;
      },
      5,
      0.5,
    );
    expect(calls).toBe(asked.size);
    expect(calls).toBeLessThanOrEqual(10);
  });

  it("with equal-strength items prefers variety as lambda falls", () => {
    // items 0 and 1 are copies of each other; item 2 is different and slightly less relevant
    const sim = (i: number, j: number): number => ([i, j].sort().join() === "0,1" ? 1 : 0);
    expect(mmrOrder([1, 0.95, 0.9], sim, 2, 1)).toEqual([0, 1]);
    expect(mmrOrder([1, 0.95, 0.9], sim, 2, 0.5)).toEqual([0, 2]);
  });

  it("rejects a lambda outside 0 to 1 and a bad k, with INVALID_ARGUMENT", () => {
    for (const bad of [
      () => mmrOrder([1], similar, 1, 1.1),
      () => mmrOrder([1], similar, 1, -0.1),
      () => mmrOrder([1], similar, 1, Number.NaN),
      () => mmrOrder([1], similar, 0, 0.5),
      () => mmrOrder([1], similar, 1.5, 0.5),
    ]) {
      try {
        bad();
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(RagError);
        expect((error as RagError).code).toBe("INVALID_ARGUMENT");
      }
    }
  });
});

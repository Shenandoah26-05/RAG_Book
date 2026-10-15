import { describe, expect, it } from "vitest";
import type { ChunkId, ScoredId } from "../../core/index.js";
import { TopK, ranksAbove } from "./top-k.js";

const id = (n: number): ChunkId => `c${n.toString().padStart(4, "0")}` as ChunkId;

/** A small repeatable pseudo-random generator, so a failing case can be reproduced. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

const fullSort = (hits: ScoredId[], k: number): ScoredId[] =>
  [...hits].sort((a, b) => (ranksAbove(a, b) ? -1 : ranksAbove(b, a) ? 1 : 0)).slice(0, k);

describe("ranksAbove", () => {
  it("prefers the higher score, then the lower id", () => {
    expect(ranksAbove({ id: id(2), score: 0.9 }, { id: id(1), score: 0.5 })).toBe(true);
    expect(ranksAbove({ id: id(1), score: 0.5 }, { id: id(2), score: 0.9 })).toBe(false);
    expect(ranksAbove({ id: id(1), score: 0.5 }, { id: id(2), score: 0.5 })).toBe(true);
    expect(ranksAbove({ id: id(2), score: 0.5 }, { id: id(1), score: 0.5 })).toBe(false);
    expect(ranksAbove({ id: id(1), score: 0.5 }, { id: id(1), score: 0.5 })).toBe(false);
  });
});

describe("TopK", () => {
  it("returns the best hits first", () => {
    const top = new TopK(3);
    [0.2, 0.9, 0.5, 0.7, 0.1].forEach((score, n) => {
      top.offer(id(n), score);
    });
    expect(top.results().map((h) => h.score)).toEqual([0.9, 0.7, 0.5]);
  });

  it("returns everything, sorted, when fewer than k hits were offered", () => {
    const top = new TopK(10);
    top.offer(id(1), 0.3);
    top.offer(id(2), 0.8);
    expect(top.results().map((h) => h.id)).toEqual([id(2), id(1)]);
  });

  it("returns nothing when nothing was offered", () => {
    expect(new TopK(5).results()).toEqual([]);
  });

  it("orders equal scores by id, whatever order they were offered in", () => {
    const top = new TopK(2);
    [5, 3, 9, 1, 7].forEach((n) => {
      top.offer(id(n), 0.5);
    });
    expect(top.results().map((h) => h.id)).toEqual([id(1), id(3)]);
  });

  it("never keeps more than k hits", () => {
    const top = new TopK(4);
    for (let n = 0; n < 1000; n += 1) {
      top.offer(id(n), (n * 37) % 101);
      expect(top.size).toBeLessThanOrEqual(4);
    }
    expect(top.size).toBe(4);
  });

  it.each([1, 2, 7, 50, 400])("gives the same answer as sorting everything (k = %i)", (k) => {
    const next = random(k);
    // few distinct scores, so there are many ties
    const hits = Array.from({ length: 400 }, (_, n) => ({
      id: id(n),
      score: Math.floor(next() * 40) / 40,
    }));
    const top = new TopK(k);
    for (const hit of hits) top.offer(hit.id, hit.score);
    expect(top.results()).toEqual(fullSort(hits, k));
  });

  it.each([0, -1, 1.5, Number.NaN])("rejects k = %s", (k) => {
    expect(() => new TopK(k)).toThrow(/k must be a whole number/);
  });
});

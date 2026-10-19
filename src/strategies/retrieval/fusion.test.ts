import { describe, expect, it } from "vitest";
import type { ChunkId, FusionStrategy, RankedList, ScoredId } from "../../core/index.js";
import { RrfFusion } from "./rrf-fusion.js";
import { WeightedFusion } from "./weighted-fusion.js";

const id = (name: string): ChunkId => name as ChunkId;
const list = (retriever: string, ...hits: [string, number][]): RankedList => ({
  retriever,
  hits: hits.map(([name, score]) => ({ id: id(name), score })),
});
const order = (hits: readonly ScoredId[]): string[] => hits.map((h) => h.id);
const scoreOf = (hits: readonly ScoredId[], name: string): number =>
  hits.find((h) => h.id === name)?.score ?? Number.NaN;

// Fixed rankings used throughout. Cosine scores on one side, unbounded BM25 scores on the other.
//   dense: a 0.9, b 0.5, c 0.1        bm25: b 12, d 6, a 0
const dense = list("dense", ["a", 0.9], ["b", 0.5], ["c", 0.1]);
const bm25 = list("bm25", ["b", 12], ["d", 6], ["a", 0]);

describe("RrfFusion", () => {
  it("adds 1 / (60 + rank) for every list a chunk is in, computed by hand", () => {
    const fused = new RrfFusion().fuse([dense, bm25]);
    // a: rank 1 and 3   b: rank 2 and 1   c: rank 3 only   d: rank 2 only
    expect(scoreOf(fused, "a")).toBeCloseTo(1 / 61 + 1 / 63, 12);
    expect(scoreOf(fused, "b")).toBeCloseTo(1 / 62 + 1 / 61, 12);
    expect(scoreOf(fused, "c")).toBeCloseTo(1 / 63, 12);
    expect(scoreOf(fused, "d")).toBeCloseTo(1 / 62, 12);
    expect(order(fused)).toEqual(["b", "a", "d", "c"]);
  });

  it("uses a different k when asked", () => {
    const fused = new RrfFusion(1).fuse([list("x", ["a", 1], ["b", 1]), list("y", ["b", 1])]);
    // k = 1: a = 1/2, b = 1/3 + 1/2
    expect(scoreOf(fused, "a")).toBeCloseTo(1 / 2, 12);
    expect(scoreOf(fused, "b")).toBeCloseTo(1 / 3 + 1 / 2, 12);
  });

  it("ignores the scores, so rescaling a retriever changes nothing", () => {
    const scaled = list("bm25", ["b", 12_000], ["d", 0.006], ["a", -5]);
    expect(new RrfFusion().fuse([dense, scaled])).toEqual(new RrfFusion().fuse([dense, bm25]));
  });

  it("ranks a chunk that is high in both lists above one that tops just one", () => {
    const fused = new RrfFusion().fuse([
      list("x", ["solo", 1], ["both", 0.9]),
      list("y", ["other", 1], ["both", 0.9]),
    ]);
    expect(order(fused)[0]).toBe("both");
  });

  it.each([0, -1, 1.5, Number.NaN])("rejects k = %s", (k) => {
    expect(() => new RrfFusion(k)).toThrow(/whole number of 1 or more/);
  });
});

describe("WeightedFusion", () => {
  const fusion = new WeightedFusion({ dense: 0.7, bm25: 0.3 });

  it("normalises each list to 0..1 and adds weight x score, computed by hand", () => {
    const fused = fusion.fuse([dense, bm25]);
    // dense normalised: a 1, b 0.5, c 0     bm25 normalised: b 1, d 0.5, a 0
    expect(scoreOf(fused, "a")).toBeCloseTo(0.7 * 1 + 0.3 * 0, 12);
    expect(scoreOf(fused, "b")).toBeCloseTo(0.7 * 0.5 + 0.3 * 1, 12);
    expect(scoreOf(fused, "c")).toBeCloseTo(0, 12);
    expect(scoreOf(fused, "d")).toBeCloseTo(0.3 * 0.5, 12);
    expect(order(fused)).toEqual(["a", "b", "d", "c"]);
  });

  it("is not what adding the raw scores gives: BM25's bigger scale would decide everything", () => {
    const raw = new Map<string, number>();
    for (const l of [dense, bm25])
      for (const h of l.hits) raw.set(h.id, (raw.get(h.id) ?? 0) + h.score);
    const byRawSum = [...raw].sort((x, y) => y[1] - x[1]).map(([name]) => name);
    expect(byRawSum).toEqual(["b", "d", "a", "c"]);
    expect(order(fusion.fuse([dense, bm25]))).not.toEqual(byRawSum);
  });

  it("does not change when a retriever's scores are rescaled", () => {
    const scaled = list("bm25", ["b", 1200], ["d", 600], ["a", 0]);
    expect(fusion.fuse([dense, scaled])).toEqual(fusion.fuse([dense, bm25]));
  });

  it("uses only the proportions of the weights", () => {
    const a = new WeightedFusion({ dense: 7, bm25: 3 }).fuse([dense, bm25]);
    const b = fusion.fuse([dense, bm25]);
    expect(order(a)).toEqual(order(b));
    a.forEach((hit, i) => {
      expect(hit.score).toBeCloseTo(b[i]?.score ?? Number.NaN, 12);
    });
  });

  it("keeps scores between 0 and 1, and is divided over the lists that are present", () => {
    const fused = fusion.fuse([dense]);
    expect(scoreOf(fused, "a")).toBeCloseTo(1, 12);
    expect(fused.every((h) => h.score >= 0 && h.score <= 1)).toBe(true);
  });

  it("counts every hit of a list with no spread as 1, including a single hit", () => {
    const fused = new WeightedFusion({ x: 1, y: 1 }).fuse([
      list("x", ["a", 0.4], ["b", 0.4]),
      list("y", ["c", 3]),
    ]);
    expect(scoreOf(fused, "a")).toBeCloseTo(0.5, 12);
    expect(scoreOf(fused, "b")).toBeCloseTo(0.5, 12);
    expect(scoreOf(fused, "c")).toBeCloseTo(0.5, 12);
  });

  it("rejects a bad weight, a missing weight, and all weights zero", () => {
    expect(() => new WeightedFusion({ dense: -1 })).toThrow(/0 or more/);
    expect(() => new WeightedFusion({ dense: Number.NaN })).toThrow(/0 or more/);
    expect(() => new WeightedFusion({ dense: 1 }).fuse([dense, bm25])).toThrow(
      /No weight for the retriever "bm25".*dense/,
    );
    expect(() => new WeightedFusion({ dense: 0, bm25: 0 }).fuse([dense, bm25])).toThrow(
      /greater than 0/,
    );
  });

  it("lets a retriever with weight 0 add nothing but its own chunks", () => {
    const fused = new WeightedFusion({ dense: 1, bm25: 0 }).fuse([dense, bm25]);
    expect(order(fused).slice(0, 3)).toEqual(["a", "b", "c"]);
    expect(scoreOf(fused, "d")).toBe(0);
  });
});

const strategies: readonly [string, FusionStrategy][] = [
  ["RrfFusion", new RrfFusion()],
  ["WeightedFusion", new WeightedFusion({ dense: 0.5, bm25: 0.5, third: 1 })],
];

describe.each(strategies)("%s satisfies the FusionStrategy rules", (_label, fusion) => {
  it("returns every id once, best first, with equal scores ordered by id", () => {
    const fused = fusion.fuse([dense, bm25]);
    expect(new Set(order(fused))).toEqual(new Set(["a", "b", "c", "d"]));
    expect(fused).toHaveLength(4);
    fused.forEach((hit, i) => {
      const before = fused[i - 1];
      if (before === undefined) return;
      expect(hit.score).toBeLessThanOrEqual(before.score);
      if (hit.score === before.score) expect(hit.id > before.id).toBe(true);
    });
  });

  it("orders ties by id however the lists are given", () => {
    const x = list("dense", ["z", 1], ["m", 0.5]);
    const y = list("bm25", ["m", 1], ["z", 0.5]);
    // z and m are symmetric: same fused score either way, so the lower id comes first
    expect(order(fusion.fuse([x, y]))).toEqual(["m", "z"]);
    expect(order(fusion.fuse([y, x]))).toEqual(["m", "z"]);
  });

  it("does not change its input and gives the same result twice", () => {
    const lists = [dense, bm25];
    const before = JSON.stringify(lists);
    const first = fusion.fuse(lists);
    expect(JSON.stringify(lists)).toBe(before);
    expect(fusion.fuse(lists)).toEqual(first);
  });

  it("gives an empty result for no lists and for lists with no hits", () => {
    expect(fusion.fuse([])).toEqual([]);
    expect(fusion.fuse([list("dense"), list("bm25")])).toEqual([]);
  });

  it("passes one list through in its own order", () => {
    expect(order(fusion.fuse([dense]))).toEqual(["a", "b", "c"]);
  });

  it("rejects two lists from the same retriever and a repeated id in one list", () => {
    expect(() => fusion.fuse([dense, list("dense", ["x", 1])])).toThrow(
      /each retriever may appear once/,
    );
    expect(() => fusion.fuse([list("dense", ["a", 1], ["a", 0.5])])).toThrow(/appears twice/);
  });
});

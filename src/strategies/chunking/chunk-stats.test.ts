import { describe, expect, it } from "vitest";
import type { Chunk } from "../../core/index.js";
import { RagError } from "../../shared/index.js";
import { makeDocument } from "../../testing/make-document.testing.js";
import { createChunk } from "./chunk-builder.js";
import { summarizeChunks } from "./chunk-stats.js";

/** Chunks whose text is `n` letters, so with a counter of `text.length` their size is `n`. */
function chunksOfSizes(sizes: readonly number[]) {
  const doc = makeDocument([sizes.map((n) => "a".repeat(n)).join(" ")]);
  let start = 0;
  return sizes.map((n) => {
    const chunk = createChunk(doc, "test", { start, end: start + n });
    start += n + 1;
    return chunk;
  });
}

const length = (text: string): number => text.length;

describe("summarizeChunks", () => {
  it("gives zeros and no buckets for no chunks", () => {
    expect(summarizeChunks([], length)).toEqual({
      count: 0,
      sizes: [],
      min: 0,
      max: 0,
      mean: 0,
      median: 0,
      histogram: [],
    });
  });

  it("measures count, min, max, mean and median of the chunk text", () => {
    const stats = summarizeChunks(chunksOfSizes([10, 20, 60]), length);
    expect(stats).toMatchObject({ count: 3, sizes: [10, 20, 60], min: 10, max: 60, mean: 30 });
    expect(stats.median).toBe(20);
  });

  it("takes the middle of the two middle sizes as the median of an even count", () => {
    expect(summarizeChunks(chunksOfSizes([4, 10, 2, 8]), length).median).toBe(6);
  });

  it("puts every chunk in exactly one bucket, with buckets that join up", () => {
    const stats = summarizeChunks(chunksOfSizes([1, 5, 9, 33, 34, 80, 100]), length, 4);
    expect(stats.histogram.reduce((sum, b) => sum + b.count, 0)).toBe(7);
    expect(stats.histogram[0]?.from).toBe(1);
    expect(stats.histogram.at(-1)?.to).toBe(101);
    stats.histogram.slice(1).forEach((bucket, i) => {
      expect(bucket.from).toBe(stats.histogram[i]?.to);
    });
  });

  it("counts a size on a bucket edge in the bucket that starts there", () => {
    // sizes 1..8 in 4 buckets of width 2: [1,3) [3,5) [5,7) [7,9)
    const stats = summarizeChunks(chunksOfSizes([1, 2, 3, 4, 5, 6, 7, 8]), length, 4);
    expect(stats.histogram.map((b) => b.count)).toEqual([2, 2, 2, 2]);
  });

  it("uses one bucket when all chunks are the same size", () => {
    const stats = summarizeChunks(chunksOfSizes([7, 7, 7]), length);
    expect(stats.histogram).toEqual([{ from: 7, to: 8, count: 3 }]);
  });

  it("uses fewer buckets than asked for when the sizes are close together", () => {
    expect(summarizeChunks(chunksOfSizes([5, 6, 7]), length, 8).histogram).toHaveLength(3);
  });

  it("counts tokens with the function it is given, on text and not on embedText", () => {
    const chunk = {
      ...chunksOfSizes([9])[0],
      embedText: "Chapter > Section\n\nlonger text",
    } as Chunk;
    expect(summarizeChunks([chunk], (text) => text.length / 3).sizes).toEqual([3]);
  });

  it("rejects a bucket count that is not a whole number of 1 or more", () => {
    for (const bad of [0, -1, 1.5]) {
      expect(() => summarizeChunks([], length, bad)).toThrow(RagError);
    }
  });
});

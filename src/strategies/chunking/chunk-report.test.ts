import { describe, expect, it } from "vitest";
import { RagError } from "../../shared/index.js";
import { makeDocument } from "../../testing/make-document.testing.js";
import { createChunk } from "./chunk-builder.js";
import {
  renderChunkReport,
  renderHistogram,
  renderSummaryLine,
  sampleChunks,
  seedFrom,
} from "./chunk-report.js";
import { summarizeChunks } from "./chunk-stats.js";

const doc = makeDocument(["alpha beta gamma delta epsilon zeta eta theta iota kappa"]);
const words = doc.text.split(" ");
const chunks = (() => {
  let start = 0;
  return words.map((word) => {
    const chunk = createChunk(doc, "test", { start, end: start + word.length });
    start += word.length + 1;
    return chunk;
  });
})();

describe("seedFrom", () => {
  it("gives the same number for the same text and a different one for other text", () => {
    expect(seedFrom("doc|recursive")).toBe(seedFrom("doc|recursive"));
    expect(seedFrom("doc|recursive")).not.toBe(seedFrom("doc|fixed-size"));
  });
});

describe("sampleChunks", () => {
  it("returns the same picks for the same seed and different picks for another", () => {
    const first = sampleChunks(chunks, 3, 1).map((c) => c.id);
    expect(sampleChunks(chunks, 3, 1).map((c) => c.id)).toEqual(first);
    const others = [2, 3, 4, 5].map((seed) => sampleChunks(chunks, 3, seed).map((c) => c.id));
    expect(others.some((ids) => ids.join() !== first.join())).toBe(true);
  });

  it("returns distinct chunks in document order", () => {
    const picked = sampleChunks(chunks, 4, 99);
    expect(new Set(picked.map((c) => c.id)).size).toBe(4);
    const starts = picked.map((c) => c.metadata.charStart);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });

  it("returns every chunk when asked for more than there are, and none for 0 or no chunks", () => {
    expect(sampleChunks(chunks, 50, 1)).toHaveLength(chunks.length);
    expect(sampleChunks(chunks, 0, 1)).toEqual([]);
    expect(sampleChunks([], 3, 1)).toEqual([]);
  });

  it("does not change the list it is given", () => {
    const before = chunks.map((c) => c.id);
    sampleChunks(chunks, 3, 5);
    expect(chunks.map((c) => c.id)).toEqual(before);
  });

  it("rejects a count that is not a whole number of 0 or more", () => {
    expect(() => sampleChunks(chunks, -1, 1)).toThrow(RagError);
    expect(() => sampleChunks(chunks, 1.5, 1)).toThrow(RagError);
  });
});

describe("renderHistogram", () => {
  it("draws the biggest bucket with the longest bar and keeps a bar for any non-empty bucket", () => {
    const stats = summarizeChunks(chunks, (text) => text.length, 4);
    const lines = renderHistogram(stats);
    expect(lines).toHaveLength(stats.histogram.length);
    const bars = lines.map((line) => (line.match(/█/g) ?? []).length);
    stats.histogram.forEach((bucket, i) => {
      expect(bars[i] === 0).toBe(bucket.count === 0);
    });
    expect(Math.max(...bars)).toBe(30);
  });

  it("is empty for no chunks", () => {
    expect(renderHistogram(summarizeChunks([], () => 0))).toEqual([]);
  });
});

describe("renderSummaryLine", () => {
  it("lists the count and the token statistics", () => {
    const stats = summarizeChunks(chunks, (text) => text.length);
    expect(renderSummaryLine(stats)).toBe(
      "chunks: 10   tokens: min 3 / median 5 / mean 4.7 / max 7",
    );
  });
});

describe("renderChunkReport", () => {
  const stats = summarizeChunks(chunks, (text) => text.length);
  const input = {
    docId: doc.id,
    title: "Sample",
    strategy: "test",
    tokenizer: "approx",
    maxTokens: 400,
    overlapTokens: 60,
    stats,
    chunks,
  };

  it("starts with the settings and statistics, then lists every chunk in order", () => {
    const report = renderChunkReport(input);
    expect(report).toContain('# Chunks: test on "Sample"');
    expect(report).toContain("maxTokens 400, overlapTokens 60");
    expect(report).toContain("chunks: 10");
    expect(report).toContain("### 1. 5 tokens, page 1");
    expect(report).toContain("### 10. 5 tokens, page 1");
    expect(report.indexOf("alpha")).toBeLessThan(report.indexOf("kappa"));
    expect(report).toContain("- span: [0, 5)");
  });

  it("shows the section path and embedText when a chunk has them", () => {
    const [first] = chunks;
    const chunk = {
      ...first,
      embedText: "Chapter 1 > Intro\n\nalpha",
      metadata: { ...first?.metadata, sectionPath: ["Chapter 1", "Intro"] },
    } as (typeof chunks)[number];
    const report = renderChunkReport({ ...input, chunks: [chunk] });
    expect(report).toContain("- section: Chapter 1 > Intro");
    expect(report).toContain("- embedText: Chapter 1 > Intro ⏎ alpha");
  });

  it("fences chunk text with more backticks than the text contains", () => {
    const [first] = chunks;
    const chunk = { ...first, text: "uses ``` fences" } as (typeof chunks)[number];
    expect(renderChunkReport({ ...input, chunks: [chunk] })).toContain(
      "````\nuses ``` fences\n````",
    );
  });

  it("says so when there are no chunks", () => {
    const empty = renderChunkReport({
      ...input,
      chunks: [],
      stats: summarizeChunks([], () => 0),
    });
    expect(empty).toContain("No chunks: the document has no text.");
  });
});

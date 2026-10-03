import { describe, expect, it } from "vitest";
import { contentHash, makeChunkId, makeDocId } from "./ids.js";
import type { ChunkId, DocId } from "./ids.js";

describe("contentHash", () => {
  it("is a 64-character lowercase hex string", () => {
    expect(contentHash("hello")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable: a known input always gives the same output", () => {
    // Pinned value (sha256 of "5:hello|"). If this changes, every stored id changes.
    // Do not update it casually.
    expect(contentHash("hello")).toBe(
      "af74150d0c4da8f57a712d1087a92480fbd3d8996422cddef08cfec0d3ed5c2a",
    );
  });

  it("depends on part boundaries, not just the concatenated text", () => {
    expect(contentHash("ab", "c")).not.toBe(contentHash("a", "bc"));
    expect(contentHash("a", "")).not.toBe(contentHash("", "a"));
  });
});

describe("makeDocId", () => {
  it("is the same for the same file hash and differs for another", () => {
    expect(makeDocId("abc")).toBe(makeDocId("abc"));
    expect(makeDocId("abc")).not.toBe(makeDocId("abd"));
  });
});

describe("makeChunkId", () => {
  const docId = makeDocId("abc");
  const base = { docId, strategy: "recursive", charStart: 0, charEnd: 5, text: "hello" };

  it("is stable for identical input", () => {
    expect(makeChunkId(base)).toBe(makeChunkId({ ...base }));
  });

  it.each([
    ["strategy", { strategy: "fixed-size" }],
    ["charStart", { charStart: 1 }],
    ["charEnd", { charEnd: 6 }],
    ["text", { text: "world" }],
    ["docId", { docId: makeDocId("other") }],
  ])("changes when %s changes", (_name, override) => {
    expect(makeChunkId({ ...base, ...override })).not.toBe(makeChunkId(base));
  });

  it("does not confuse a DocId with a ChunkId at compile time", () => {
    const chunkId: ChunkId = makeChunkId(base);
    // @ts-expect-error a ChunkId is not assignable to a DocId
    const wrong: DocId = chunkId;
    expect(wrong).toBe(chunkId);
  });
});

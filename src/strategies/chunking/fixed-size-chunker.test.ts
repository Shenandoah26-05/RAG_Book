import { describe, expect, it } from "vitest";
import { RagError } from "../../shared/index.js";
import { describeChunkerContract } from "../../testing/chunker-contract.testing.js";
import { fixedWidthTokenizer, wordTokenizer } from "../../testing/fake-tokenizer.testing.js";
import { makeDocument } from "../../testing/make-document.testing.js";
import { FixedSizeChunker } from "./fixed-size-chunker.js";

// With fixedWidthTokenizer(1) one token is one character, so windows are easy to count by hand.
const chars = fixedWidthTokenizer(1);
const spansOf = async (chunker: FixedSizeChunker, text: string): Promise<[number, number][]> =>
  (await chunker.chunk(makeDocument([text]))).map((c) => [
    c.metadata.charStart,
    c.metadata.charEnd,
  ]);

describeChunkerContract("fixed-size (characters)", () => new FixedSizeChunker(chars, 7, 2));
describeChunkerContract("fixed-size (words)", () => new FixedSizeChunker(wordTokenizer(), 5, 1));
describeChunkerContract("fixed-size (no overlap)", () => new FixedSizeChunker(chars, 20, 0));
describeChunkerContract("fixed-size (tiny)", () => new FixedSizeChunker(chars, 2, 1));

describe("FixedSizeChunker constructor", () => {
  const invalid = (size: number, overlap: number): void => {
    expect(() => new FixedSizeChunker(chars, size, overlap)).toThrow(RagError);
  };

  it("rejects an overlap equal to or larger than the size", () => {
    invalid(10, 10);
    invalid(10, 11);
  });

  it("rejects a size that is not a positive whole number", () => {
    invalid(0, 0);
    invalid(-5, 0);
    invalid(2.5, 0);
    invalid(Number.NaN, 0);
  });

  it("rejects an overlap that is negative or not whole", () => {
    invalid(10, -1);
    invalid(10, 1.5);
  });

  it("reports CONFIG_INVALID and says what was wrong", () => {
    try {
      new FixedSizeChunker(chars, 10, 10);
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ code: "CONFIG_INVALID" });
      expect((error as Error).message).toMatch(/overlap/);
    }
  });

  it("accepts the smallest valid setting", () => {
    expect(new FixedSizeChunker(chars, 1, 0).name).toBe("fixed-size");
  });
});

describe("FixedSizeChunker windows", () => {
  it("returns no chunks for an empty document", async () => {
    expect(await new FixedSizeChunker(chars, 5, 1).chunk(makeDocument([""]))).toEqual([]);
    expect(await new FixedSizeChunker(chars, 5, 1).chunk(makeDocument([]))).toEqual([]);
  });

  it("returns no chunks for a document of only whitespace", async () => {
    expect(await spansOf(new FixedSizeChunker(chars, 3, 1), "   \n\n  ")).toEqual([]);
  });

  it("returns one chunk for text shorter than one window", async () => {
    expect(await spansOf(new FixedSizeChunker(chars, 50, 10), "short text")).toEqual([[0, 10]]);
  });

  it("returns one chunk for text exactly one window long", async () => {
    expect(await spansOf(new FixedSizeChunker(chars, 10, 3), "0123456789")).toEqual([[0, 10]]);
  });

  it("splits an exact multiple with no overlap into equal windows and no extra chunk", async () => {
    expect(await spansOf(new FixedSizeChunker(chars, 5, 0), "abcdefghij")).toEqual([
      [0, 5],
      [5, 10],
    ]);
  });

  it("slides by size minus overlap", async () => {
    // step 3: [0,5) [3,8) [6,10)
    expect(await spansOf(new FixedSizeChunker(chars, 5, 2), "abcdefghij")).toEqual([
      [0, 5],
      [3, 8],
      [6, 10],
    ]);
  });

  it("ends with a window that reaches the end, not one fully inside the previous one", async () => {
    // n = 9, step 3: [0,5) [3,8) [6,9); a fourth window [9,..) must not exist
    const spans = await spansOf(new FixedSizeChunker(chars, 5, 2), "abcdefghi");
    expect(spans).toEqual([
      [0, 5],
      [3, 8],
      [6, 9],
    ]);
  });

  it("makes the last chunk shorter when the text does not divide evenly", async () => {
    expect(await spansOf(new FixedSizeChunker(chars, 4, 0), "abcdefghij")).toEqual([
      [0, 4],
      [4, 8],
      [8, 10],
    ]);
  });

  it("handles size 1 with no overlap", async () => {
    expect(await spansOf(new FixedSizeChunker(chars, 1, 0), "abc")).toEqual([
      [0, 1],
      [1, 2],
      [2, 3],
    ]);
  });

  it("handles the largest overlap (size - 1) and still ends", async () => {
    expect(await spansOf(new FixedSizeChunker(chars, 3, 2), "abcde")).toEqual([
      [0, 3],
      [1, 4],
      [2, 5],
    ]);
  });

  it("measures windows in tokens, not characters", async () => {
    // fixedWidthTokenizer(4): 20 characters are 5 tokens; size 2, overlap 0 gives 3 windows
    const chunker = new FixedSizeChunker(fixedWidthTokenizer(4), 2, 0);
    expect(await spansOf(chunker, "a".repeat(20))).toEqual([
      [0, 8],
      [8, 16],
      [16, 20],
    ]);
  });

  it("puts chunk edges on word edges when the tokens are words", async () => {
    const chunker = new FixedSizeChunker(wordTokenizer(), 2, 0);
    const doc = makeDocument(["one two three four five"]);
    const texts = (await chunker.chunk(doc)).map((c) => c.text);
    expect(texts).toEqual(["one two ", "three four ", "five"]);
  });

  it("keeps the exact passage as the chunk text", async () => {
    const doc = makeDocument(["  padded  text  "]);
    const [chunk] = await new FixedSizeChunker(chars, 100, 0).chunk(doc);
    expect(chunk?.text).toBe(doc.text);
  });

  it("skips a window that holds only whitespace instead of failing", async () => {
    // the page separator "\n\n" sits between the pages; with size 2 it is a window of its own
    const doc = makeDocument(["ab", "cd"]);
    const chunks = await new FixedSizeChunker(chars, 2, 0).chunk(doc);
    expect(chunks.map((c) => c.text)).toEqual(["ab", "cd"]);
  });

  it("writes its own name as the strategy and fills in pages", async () => {
    const doc = makeDocument(["first page", "second page"]);
    const chunks = await new FixedSizeChunker(chars, 12, 0).chunk(doc);
    expect(chunks.every((c) => c.metadata.strategy === "fixed-size")).toBe(true);
    expect(chunks[0]?.metadata.pageStart).toBe(1);
    expect(chunks.at(-1)?.metadata.pageEnd).toBe(2);
  });

  it("gives the same chunks every time and does not change the document", async () => {
    const doc = makeDocument(["a b c d e f g h i j k l m n o p"]);
    const before = JSON.stringify(doc);
    const chunker = new FixedSizeChunker(wordTokenizer(), 3, 1);
    expect(await chunker.chunk(doc)).toEqual(await chunker.chunk(doc));
    expect(JSON.stringify(doc)).toBe(before);
  });
});

import { describe, expect, it } from "vitest";
import {
  chunkerFixtures,
  describeChunkerContract,
} from "../../testing/chunker-contract.testing.js";
import { makeDocument } from "../../testing/make-document.testing.js";
import { RecursiveChunker } from "./recursive-chunker.js";
import { packPieces, splitRecursive, type TokenCounter } from "./recursive-split.js";

// Stand-in for the tokenizer (RAG-021): one token per 4 characters, rounded up.
const count: TokenCounter = (text) => Math.ceil(text.length / 4);

const texts = (text: string, spans: readonly { start: number; end: number }[]): string[] =>
  spans.map((span) => text.slice(span.start, span.end));

describe("splitRecursive", () => {
  const seps = ["\n\n", "\n", " "];

  it("gives nothing for empty text", () => {
    expect(splitRecursive("", count, seps, 10)).toEqual([]);
  });

  it("keeps text that fits as one piece", () => {
    expect(splitRecursive("short text", count, seps, 10)).toEqual([[{ start: 0, end: 10 }]]);
  });

  it("cuts on the biggest separator first and keeps the separator with the piece before it", () => {
    const text = "aaaa bbbb\n\ncccc dddd";
    expect(texts(text, splitRecursive(text, count, seps, 4).flat())).toEqual([
      "aaaa bbbb\n\n",
      "cccc dddd",
    ]);
  });

  it("only uses a smaller separator on pieces that are still too long", () => {
    const text = "one two three four\n\nfive";
    expect(texts(text, splitRecursive(text, count, seps, 4).flat())).toEqual([
      "one ",
      "two ",
      "three ",
      "four\n",
      "\n",
      "five",
    ]);
  });

  it("keeps the pieces of a too-long piece apart from the pieces next to it", () => {
    const text = "tiny\n\nword word word word word word\n\nend";
    const groups = splitRecursive(text, count, seps, 4).map((group) => texts(text, group));
    expect(groups[0]).toEqual(["tiny\n\n"]);
    expect(groups.at(-1)).toEqual(["end"]);
    expect(groups.length).toBeGreaterThan(2);
  });

  it("skips a separator that is not in the text", () => {
    const text = "alpha beta gamma delta";
    expect(texts(text, splitRecursive(text, count, ["\n\n", "\n", " "], 5).flat())).toEqual([
      "alpha ",
      "beta ",
      "gamma ",
      "delta",
    ]);
  });

  it("cuts by length when no separator is left", () => {
    const text = "abcdefghijklmnopqrstuvwxyz";
    const pieces = splitRecursive(text, count, [], 3).flat();
    expect(texts(text, pieces)).toEqual(["abcdefghijkl", "mnopqrstuvwx", "yz"]);
  });

  it("never cuts between the two halves of a surrogate pair", () => {
    const text = "\u{1F600}".repeat(10); // 20 UTF-16 units
    const pieces = splitRecursive(text, (t) => t.length, [], 3).flat();
    for (const piece of texts(text, pieces)) expect(piece).toMatch(/^(\u{1F600})+$/u);
  });

  it("returns a lone character that is over the limit instead of looping", () => {
    expect(splitRecursive("ab", () => 99, [], 1).flat()).toEqual([
      { start: 0, end: 1 },
      { start: 1, end: 2 },
    ]);
  });

  it("covers the text exactly, in order, whatever the input", () => {
    const text =
      "First.  Second? Third!\nFourth line\n\n\nFifth   para, with, commas and more words.";
    for (const max of [1, 2, 3, 5, 8, 100]) {
      const pieces = splitRecursive(text, count, ["\n\n", "\n", ". ", "? ", "! ", " "], max).flat();
      expect(texts(text, pieces).join("")).toBe(text);
      let at = 0;
      for (const piece of pieces) {
        expect(piece.start).toBe(at);
        at = piece.end;
      }
    }
  });
});

describe("packPieces", () => {
  const pieces = (text: string, size: number) =>
    Array.from({ length: Math.ceil(text.length / size) }, (_, i) => ({
      start: i * size,
      end: Math.min((i + 1) * size, text.length),
    }));

  it("gives nothing for no pieces", () => {
    expect(packPieces("", [], count, 10, 0)).toEqual([]);
  });

  it("packs whole pieces up to the limit", () => {
    const text = "a".repeat(40); // 10 tokens, in pieces of 4 characters = 1 token
    const chunks = packPieces(text, pieces(text, 4), count, 4, 0);
    expect(chunks.map((c) => c.end - c.start)).toEqual([16, 16, 8]);
  });

  it("repeats whole pieces from the end of a chunk as overlap", () => {
    const text = "a".repeat(40);
    const chunks = packPieces(text, pieces(text, 4), count, 4, 1);
    expect(chunks).toEqual([
      { start: 0, end: 16 },
      { start: 12, end: 28 },
      { start: 24, end: 40 },
    ]);
  });

  it("never repeats more than the overlap and always moves forward", () => {
    const text = "a".repeat(100);
    for (const overlap of [0, 1, 2, 3]) {
      const chunks = packPieces(text, pieces(text, 4), count, 4, overlap);
      let lastEnd = 0;
      for (const chunk of chunks) {
        expect(chunk.end).toBeGreaterThan(lastEnd);
        lastEnd = chunk.end;
      }
      expect(lastEnd).toBe(100);
      for (let i = 1; i < chunks.length; i += 1) {
        const repeated = (chunks[i - 1]?.end ?? 0) - (chunks[i]?.start ?? 0);
        expect(repeated).toBeLessThanOrEqual(overlap * 4);
      }
    }
  });
});

describe("RecursiveChunker", () => {
  const make = (maxTokens = 10, overlapTokens = 2, separators?: string[]) =>
    new RecursiveChunker({
      maxTokens,
      overlapTokens,
      count,
      ...(separators ? { separators } : {}),
    });

  describeChunkerContract("recursive", () => make());
  describeChunkerContract("recursive, no overlap", () => make(10, 0));
  describeChunkerContract("recursive, tiny chunks", () => make(3, 1));
  describeChunkerContract("recursive, characters only", () => make(10, 2, []));

  it("never makes a chunk longer than maxTokens, on every fixture", async () => {
    for (const max of [2, 5, 10, 40]) {
      for (const { doc } of chunkerFixtures()) {
        for (const chunk of await make(max, Math.min(1, max - 1)).chunk(doc)) {
          expect(count(chunk.text), `max ${max.toString()}`).toBeLessThanOrEqual(max);
        }
      }
    }
  });

  it("keeps whole paragraphs together when they fit", async () => {
    const doc = makeDocument(["First paragraph here.\n\nSecond paragraph here.\n\nThird one."]);
    const chunks = await make(12, 0).chunk(doc);
    expect(chunks.map((c) => c.text)).toEqual([
      "First paragraph here.\n\nSecond paragraph here.",
      "Third one.",
    ]);
  });

  it("falls back to sentences, then words, for a paragraph that is too long", async () => {
    const doc = makeDocument([
      "Short intro.\n\nOne long sentence runs on and on without any stop at all. Then a second one ends here.",
    ]);
    const chunks = await make(8, 0).chunk(doc);
    expect(chunks.map((c) => c.text)).toEqual([
      "Short intro.",
      "One long sentence runs on and",
      "on without any stop at all.",
      "Then a second one ends here.",
    ]);
  });

  it("uses the separators it is given", async () => {
    const doc = makeDocument(["alpha|beta|gamma|delta"]);
    const chunks = await make(4, 0, ["|"]).chunk(doc);
    expect(chunks.map((c) => c.text)).toEqual(["alpha|beta|", "gamma|delta"]);
  });

  it("records the strategy and a span that points at the chunk's text", async () => {
    const doc = makeDocument(["First paragraph here.\n\nSecond paragraph here."]);
    for (const chunk of await make(6, 0).chunk(doc)) {
      expect(chunk.metadata.strategy).toBe("recursive");
      expect(doc.text.slice(chunk.metadata.charStart, chunk.metadata.charEnd)).toBe(chunk.text);
    }
  });

  it("gives no chunks for a document with only whitespace", async () => {
    expect(await make().chunk(makeDocument(["  \n\n \t"]))).toEqual([]);
  });

  describe("constructor", () => {
    const bad = (maxTokens: number, overlapTokens: number, separators?: string[]) => () =>
      make(maxTokens, overlapTokens, separators);

    it("rejects a size that is not a whole number of 1 or more", () => {
      expect(bad(0, 0)).toThrow(/maxTokens/);
      expect(bad(2.5, 0)).toThrow(/maxTokens/);
    });

    it("rejects an overlap that is negative, fractional, or not below the size", () => {
      expect(bad(10, -1)).toThrow(/overlapTokens/);
      expect(bad(10, 0.5)).toThrow(/overlapTokens/);
      expect(bad(10, 10)).toThrow(/overlapTokens/);
    });

    it("rejects an empty separator, which could never make progress", () => {
      expect(bad(10, 0, ["\n", ""])).toThrow(/separator/);
    });
  });
});

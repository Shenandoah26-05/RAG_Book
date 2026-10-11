import { describe, expect, it } from "vitest";
import type { Chunk, Chunker, ParsedDocument } from "../../core/index.js";
import { makeDocument } from "../../testing/make-document.testing.js";
import { makeSectionedDocument } from "../../testing/sectioned-document.testing.js";
import { describeChunkerContract } from "../../testing/chunker-contract.testing.js";
import { wordTokenizer } from "../../testing/fake-tokenizer.testing.js";
import { createChunk } from "./chunk-builder.js";
import { FixedSizeChunker } from "./fixed-size-chunker.js";
import { StructureAwareChunker } from "./structure-aware-chunker.js";

/** Splits on line breaks. Records the documents it was given. */
class LineChunker implements Chunker {
  readonly name = "lines";
  readonly seen: ParsedDocument[] = [];

  chunk(doc: ParsedDocument): Promise<readonly Chunk[]> {
    this.seen.push(doc);
    const chunks = [...doc.text.matchAll(/[^\n]+/g)].map((match) =>
      createChunk(doc, this.name, { start: match.index, end: match.index + match[0].length }),
    );
    return Promise.resolve(chunks);
  }
}

const build = (maxTokens: number, minTokens: number, inner: Chunker = new LineChunker()) =>
  new StructureAwareChunker({ inner, tokenizer: wordTokenizer(), maxTokens, minTokens });

describe("StructureAwareChunker: one chunk per section", () => {
  const doc = makeSectionedDocument();

  it("gives each section its own chunk, with page range and section path", async () => {
    const chunks = await build(100, 0).chunk(doc);

    expect(chunks.map((c) => c.text)).toEqual([
      "Preface words",
      "Chapter One\nalpha beta gamma",
      "1.1 Sub\ndelta epsilon",
      "Chapter Two\nzeta eta",
    ]);
    expect(chunks.map((c) => c.metadata.sectionPath)).toEqual([
      [],
      ["Chapter One"],
      ["Chapter One", "1.1 Sub"],
      ["Chapter Two"],
    ]);
    expect(chunks.map((c) => [c.metadata.pageStart, c.metadata.pageEnd])).toEqual([
      [1, 1],
      [1, 1],
      [2, 2],
      [2, 2],
    ]);
    expect(new Set(chunks.map((c) => c.metadata.strategy))).toEqual(new Set(["structure-aware"]));
    expect(new Set(chunks.map((c) => c.id)).size).toBe(chunks.length);
  });

  it("puts the heading path in embedText and keeps text raw", async () => {
    const chunks = await build(100, 0).chunk(doc);

    expect(chunks[0]?.embedText).toBeUndefined();
    expect(chunks[2]?.text).toBe("1.1 Sub\ndelta epsilon");
    expect(chunks[2]?.embedText).toBe("Chapter One > 1.1 Sub\n\n1.1 Sub\ndelta epsilon");
  });

  it("never calls the inner chunker when every section fits", async () => {
    const inner = new LineChunker();
    await build(100, 0, inner).chunk(doc);
    expect(inner.seen).toEqual([]);
  });

  it("is deterministic and does not change the document", async () => {
    const before = JSON.stringify(doc);
    const chunker = build(100, 0);
    expect(await chunker.chunk(doc)).toEqual(await chunker.chunk(doc));
    expect(JSON.stringify(doc)).toBe(before);
  });
});

describe("StructureAwareChunker: long sections", () => {
  const doc = makeSectionedDocument();

  it("hands a long section to the inner chunker as a document of its own", async () => {
    const inner = new LineChunker();
    await build(4, 0, inner).chunk(doc);

    expect(inner.seen).toHaveLength(1);
    expect(inner.seen[0]?.text).toBe("Chapter One\nalpha beta gamma");
    expect(inner.seen[0]?.sections).toEqual([]);
  });

  it("maps the inner chunks back onto the real document", async () => {
    const chunks = await build(4, 0).chunk(doc);

    expect(chunks.map((c) => c.text)).toEqual([
      "Preface words",
      "Chapter One",
      "alpha beta gamma",
      "1.1 Sub\ndelta epsilon",
      "Chapter Two\nzeta eta",
    ]);
    for (const chunk of chunks) {
      const { charStart, charEnd, strategy } = chunk.metadata;
      expect(doc.text.slice(charStart, charEnd)).toBe(chunk.text);
      expect(strategy).toBe("structure-aware");
    }
    expect(chunks[2]?.metadata.sectionPath).toEqual(["Chapter One"]);
    expect(chunks[2]?.embedText).toBe("Chapter One\n\nalpha beta gamma");
  });

  it("rejects an inner chunk outside the section it was given", async () => {
    const big = makeDocument(["x".repeat(500)]);
    const wild: Chunker = {
      name: "wild",
      chunk: () => Promise.resolve([createChunk(big, "wild", { start: 0, end: 400 })]),
    };
    await expect(build(4, 0, wild).chunk(doc)).rejects.toMatchObject({
      code: "INTERNAL",
    });
  });
});

describe("StructureAwareChunker: small sections", () => {
  const doc = makeSectionedDocument();

  it("joins a section below minTokens with the next one", async () => {
    const chunks = await build(12, 3).chunk(doc);

    expect(chunks.map((c) => c.text)).toEqual([
      "Preface words\n\nChapter One\nalpha beta gamma",
      "1.1 Sub\ndelta epsilon",
      "Chapter Two\nzeta eta",
    ]);
  });

  it("does not join when the result would be too long", async () => {
    const chunks = await build(6, 3).chunk(doc);
    expect(chunks).toHaveLength(4);
  });
});

describe("StructureAwareChunker: edge cases", () => {
  it("returns nothing for an empty document", async () => {
    expect(await build(10, 0).chunk(makeDocument([""]))).toEqual([]);
  });

  it("falls back to the inner chunker when the document has no sections", async () => {
    const plain = makeDocument(["one two three\nfour five six"]);
    const chunks = await build(4, 0).chunk(plain);

    expect(chunks.map((c) => c.text)).toEqual(["one two three", "four five six"]);
    expect(chunks.every((c) => c.embedText === undefined)).toBe(true);
  });

  it("covers every non-whitespace character", async () => {
    const doc = makeSectionedDocument();
    const chunks = await build(4, 0).chunk(doc);
    const covered = new Set<number>();
    for (const { metadata } of chunks) {
      for (let i = metadata.charStart; i < metadata.charEnd; i += 1) {
        covered.add(i);
      }
    }
    for (let i = 0; i < doc.text.length; i += 1) {
      expect(/\s/.test(doc.text.charAt(i)) || covered.has(i)).toBe(true);
    }
  });

  it.each([
    { maxTokens: 0, minTokens: 0 },
    { maxTokens: 10, minTokens: 10 },
    { maxTokens: 10, minTokens: -1 },
  ])("rejects the sizes %o", (sizes) => {
    expect(() => build(sizes.maxTokens, sizes.minTokens)).toThrow(/Tokens/);
  });
});

// The shared contract, once with a real splitter inside and once with one that is never needed.
describeChunkerContract(
  "structure-aware (long sections split by fixed-size)",
  () =>
    new StructureAwareChunker({
      inner: new FixedSizeChunker(wordTokenizer(), 8, 2),
      tokenizer: wordTokenizer(),
      maxTokens: 12,
    }),
);
describeChunkerContract(
  "structure-aware (one chunk per section)",
  () =>
    new StructureAwareChunker({
      inner: new LineChunker(),
      tokenizer: wordTokenizer(),
      maxTokens: 10_000,
      minTokens: 0,
    }),
);

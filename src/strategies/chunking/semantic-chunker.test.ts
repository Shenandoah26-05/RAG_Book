import { describe, expect, it } from "vitest";
import type { Chunk, Embedder, ParsedDocument } from "../../core/index.js";
import { RagError, createJsonLogger } from "../../shared/index.js";
import { makeDocument } from "../../testing/make-document.testing.js";
import { describeChunkerContract } from "../../testing/chunker-contract.testing.js";
import { splitSentencesBasic } from "./basic-sentence-splitter.js";
import { createChunk } from "./chunk-builder.js";
import { SemanticChunker } from "./semantic-chunker.js";
import type { SemanticChunkerOptions } from "./semantic-chunker.js";

/** Cats point one way, stocks another: the topic of a sentence is its keyword. */
const TOPICS: Readonly<Record<string, readonly number[]>> = {
  cat: [1, 0, 0],
  stock: [0, 1, 0],
  rain: [0, 0, 1],
};

/** An embedder that also records what it was asked to embed. */
function fakeEmbedder(): Embedder & {
  readonly calls: { texts: readonly string[]; kind: string }[];
} {
  const calls: { texts: readonly string[]; kind: string }[] = [];
  return {
    modelId: "fake:topics",
    dimensions: 3,
    calls,
    embed: (texts, kind) => {
      calls.push({ texts, kind });
      const vectors = texts.map((text) => {
        const topic = Object.keys(TOPICS).find((key) => text.includes(key));
        return Float32Array.from(TOPICS[topic ?? "cat"] ?? [1, 0, 0]);
      });
      return Promise.resolve(vectors);
    },
  };
}

function chunker(
  overrides: Partial<SemanticChunkerOptions> = {},
  embedder: Embedder = fakeEmbedder(),
): SemanticChunker {
  return new SemanticChunker({
    embedder,
    splitSentences: splitSentencesBasic,
    createChunk,
    breakRule: { kind: "threshold", value: 0.5 },
    maxTokens: 1000,
    ...overrides,
  });
}

const doc = (text: string): ParsedDocument => makeDocument([text]);
const texts = (chunks: readonly Chunk[]): string[] => chunks.map((c) => c.text);

const TWO_TOPICS = "The cat sat down. A cat purrs. The stock fell. A stock rose.";

describe("SemanticChunker: where it breaks", () => {
  it("breaks where the topic changes", async () => {
    const chunks = await chunker().chunk(doc(TWO_TOPICS));
    expect(texts(chunks)).toEqual([
      "The cat sat down. A cat purrs.",
      "The stock fell. A stock rose.",
    ]);
  });

  it("makes one chunk when nothing shifts", async () => {
    const chunks = await chunker().chunk(doc("The cat sat. A cat ran. Cats nap."));
    expect(chunks).toHaveLength(1);
  });

  it("breaks at every shift for a percentile of 100", async () => {
    const chunks = await chunker({ breakRule: { kind: "percentile", value: 100 } }).chunk(
      doc("The cat sat. The stock fell. Some rain came."),
    );
    expect(texts(chunks)).toEqual(["The cat sat.", "The stock fell.", "Some rain came."]);
  });

  it("ignores a shift until the chunk has minTokens, and so avoids tiny chunks", async () => {
    const text = "Cat. The stock fell down hard today. Rain.";
    expect(texts(await chunker().chunk(doc(text)))).toHaveLength(3);
    // "Cat." is 1 token with 4 characters per token, so a shift after it is ignored at minTokens 2
    const merged = await chunker({ minTokens: 2 }).chunk(doc(text));
    expect(texts(merged)).toEqual(["Cat. The stock fell down hard today.", "Rain."]);
  });

  it("forces a break when the next sentence would exceed maxTokens", async () => {
    const same = "The cat sat on a mat. A cat sat on a rug. A cat sat on a bed.";
    // each sentence is about 6 tokens (21 characters / 4, rounded up)
    const chunks = await chunker({ maxTokens: 12 }).chunk(doc(same));
    expect(texts(chunks)).toEqual([
      "The cat sat on a mat. A cat sat on a rug.",
      "A cat sat on a bed.",
    ]);
  });

  it("keeps a single sentence that is longer than maxTokens whole", async () => {
    const chunks = await chunker({ maxTokens: 1 }).chunk(doc("A cat sat on a very long mat."));
    expect(texts(chunks)).toEqual(["A cat sat on a very long mat."]);
  });

  it("uses the given token counter", async () => {
    const chunks = await chunker({ maxTokens: 2, countTokens: () => 1 }).chunk(
      doc("A cat sat. A cat ran. A cat hid. A cat ate."),
    );
    expect(chunks).toHaveLength(2);
  });
});

describe("SemanticChunker: what it returns", () => {
  it("gives spans that slice the document to exactly the chunk text, in order", async () => {
    const document = doc(TWO_TOPICS);
    const chunks = await chunker().chunk(document);
    for (const c of chunks) {
      expect(document.text.slice(c.metadata.charStart, c.metadata.charEnd)).toBe(c.text);
      expect(c.metadata.strategy).toBe("semantic");
    }
    const [first, second] = chunks;
    expect(first?.metadata.charEnd).toBeLessThanOrEqual(second?.metadata.charStart ?? 0);
  });

  it("leaves only whitespace between chunks, across pages too", async () => {
    const document = makeDocument(["The cat sat. A cat ran.", "The stock fell. A stock rose."]);
    const chunks = await chunker().chunk(document);
    expect(chunks).toHaveLength(2);
    const [first, second] = chunks;
    const gap = document.text.slice(first?.metadata.charEnd, second?.metadata.charStart);
    expect(gap.trim()).toBe("");
  });

  it("has unique ids and is deterministic", async () => {
    const document = doc(TWO_TOPICS);
    const a = await chunker().chunk(document);
    const b = await chunker().chunk(document);
    expect(a).toEqual(b);
    expect(new Set(a.map((c) => c.id)).size).toBe(a.length);
  });

  it("returns no chunks for an empty document and does not call the embedder", async () => {
    const embedder = fakeEmbedder();
    expect(await chunker({}, embedder).chunk(doc(""))).toEqual([]);
    expect(await chunker({}, embedder).chunk(doc("  \n\n "))).toEqual([]);
    expect(embedder.calls).toEqual([]);
  });
});

describe("SemanticChunker: the embedder", () => {
  it("embeds all sentences in one call, as documents", async () => {
    const embedder = fakeEmbedder();
    await chunker({}, embedder).chunk(doc(TWO_TOPICS));
    expect(embedder.calls).toEqual([
      {
        texts: ["The cat sat down.", "A cat purrs.", "The stock fell.", "A stock rose."],
        kind: "document",
      },
    ]);
  });

  it("fails clearly when the embedder returns the wrong number of vectors", async () => {
    const broken: Embedder = {
      modelId: "fake:broken",
      dimensions: 3,
      embed: () => Promise.resolve([Float32Array.from([1, 0, 0])]),
    };
    const error = await chunker({}, broken)
      .chunk(doc(TWO_TOPICS))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RagError);
    expect((error as RagError).code).toBe("INTERNAL");
  });
});

describe("SemanticChunker: logging", () => {
  it("logs how many breaks were made, and why", async () => {
    const lines: string[] = [];
    const logger = createJsonLogger({ level: "info", write: (line) => lines.push(line) });
    await chunker({ logger, maxTokens: 6 }).chunk(doc(TWO_TOPICS));
    const record = JSON.parse(lines.join("")) as Record<string, unknown>;
    expect(record).toMatchObject({ sentences: 4, chunks: 4, topicBreaks: 1, sizeBreaks: 2 });
  });
});

// The shared contract from RAG-020, with the real createChunk and a topic-based fake embedder.
describeChunkerContract(
  "semantic chunker",
  () =>
    new SemanticChunker({
      embedder: fakeEmbedder(),
      splitSentences: splitSentencesBasic,
      createChunk,
      breakRule: { kind: "percentile", value: 30 },
      maxTokens: 50,
    }),
);

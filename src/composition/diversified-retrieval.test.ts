import { describe, expect, it } from "vitest";
import type { Chunk, ChunkId, DocId, Embedder } from "../core/index.js";
import {
  DenseRetriever,
  FlatVectorStore,
  InMemoryChunkStore,
  MmrDiversifier,
} from "../strategies/index.js";

const unit = (...v: number[]): Float32Array => {
  const length = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return Float32Array.from(v.map((x) => x / length));
};

const QUESTION = "What pets are there?";

/**
 * Texts map to fixed directions. The question leans towards the "cats" direction, so the three
 * near-copies about cats are the closest chunks; dogs and fish point along other axes (alike only
 * in being pets, so quite different from cats); the stock-market chunk is not about pets at all.
 */
const DIRECTIONS: Record<string, Float32Array> = {
  [QUESTION]: unit(1.2, 1, 1),
  "Cats are popular pets.": unit(1, 0.05, 0.05),
  "Cats are very popular pets.": unit(1, 0.06, 0.05),
  "Popular pets include cats.": unit(1, 0.05, 0.06),
  "Dogs are loyal companions.": unit(0.05, 1, 0.05),
  "Fish need clean water.": unit(0.05, 0.05, 1),
  "Stock markets fell today.": unit(-1, 0.2, 0.2),
};
const embedder: Embedder = {
  modelId: "fake:model",
  dimensions: 3,
  embed: (texts) => Promise.resolve(texts.map((t) => DIRECTIONS[t] ?? unit(1, 1, 1))),
};

const chunk = (text: string, i: number): Chunk => ({
  id: `c${i.toString()}` as ChunkId,
  text,
  metadata: {
    docId: "doc" as DocId,
    pageStart: i + 1,
    pageEnd: i + 1,
    sectionPath: [],
    charStart: i * 100,
    charEnd: i * 100 + text.length,
    strategy: "recursive",
  },
});

describe("DenseRetriever followed by MmrDiversifier", () => {
  it("keeps one of three near-copies and makes room for the other topics", async () => {
    const chunks = Object.keys(DIRECTIONS)
      .filter((text) => text !== QUESTION)
      .map(chunk);
    const vectorStore = new FlatVectorStore(3);
    await vectorStore.upsert(
      chunks.map((c) => ({
        id: c.id,
        vector: DIRECTIONS[c.text] as Float32Array,
        metadata: c.metadata,
      })),
    );
    const chunkStore = new InMemoryChunkStore();
    await chunkStore.put(chunks);

    const retriever = new DenseRetriever({ embedder, vectorStore, chunkStore });
    const candidates = await retriever.retrieve({ text: QUESTION }, { k: 6 });
    // plain retrieval: the three copies take the first three places
    expect(candidates.slice(0, 3).every((c) => /cats/i.test(c.chunk.text))).toBe(true);

    const picked = await new MmrDiversifier({ embedder, lambda: 0.5 }).diversify(candidates, 3);
    const texts = picked.map((p) => p.chunk.text);
    expect(texts.filter((t) => /cats/i.test(t))).toHaveLength(1);
    expect(texts).toContain("Dogs are loyal companions.");
    expect(texts).toContain("Fish need clean water.");
    // the best chunk is still first, and what MMR hands on keeps the retriever's name and scores
    expect(picked[0]?.chunk.id).toBe(candidates[0]?.chunk.id);
    expect(picked.map((p) => p.rank)).toEqual([1, 2, 3]);
    expect(picked.every((p) => p.retriever === "dense")).toBe(true);
  });
});

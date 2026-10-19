import { describe, expect, it } from "vitest";
import { makeChunkId } from "../../core/index.js";
import type {
  Chunk,
  ChunkStore,
  DocId,
  EmbedKind,
  Embedder,
  MetadataFilter,
  VectorStore,
} from "../../core/index.js";
import { makeDocId } from "../../shared/index.js";
import { describeRetrieverContract } from "../../testing/retriever-contract.testing.js";
import { FlatVectorStore, InMemoryChunkStore } from "../in-memory-index/index.js";
import { DenseRetriever } from "./dense-retriever.js";

const DIMENSIONS = 3;
const DOC_A = makeDocId("a".repeat(64));
const DOC_B = makeDocId("b".repeat(64));

function unit(...v: number[]): Float32Array {
  const length = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return Float32Array.from(v.map((x) => x / length));
}

function chunk(docId: DocId, text: string, start: number, page: number): Chunk {
  return {
    id: makeChunkId({
      docId,
      strategy: "recursive",
      charStart: start,
      charEnd: start + text.length,
      text,
    }),
    text,
    metadata: {
      docId,
      pageStart: page,
      pageEnd: page,
      sectionPath: [],
      charStart: start,
      charEnd: start + text.length,
      strategy: "recursive",
    },
  };
}

/** Five chunks; each question points in a direction, and the chunks sit around it. */
const cats = chunk(DOC_A, "Cats purr and sleep a lot.", 0, 1);
const kittens = chunk(DOC_A, "Kittens are young cats.", 30, 2);
const dogs = chunk(DOC_B, "Dogs bark and fetch.", 0, 1);
const cars = chunk(DOC_B, "Cars have four wheels.", 30, 2);
const parent = chunk(DOC_A, "A whole chapter about cats, which is never searched.", 0, 1);

const VECTORS = new Map<string, Float32Array>([
  [cats.id, unit(1, 0, 0)],
  [kittens.id, unit(0.8, 0.6, 0)],
  [dogs.id, unit(0.6, 0.8, 0)],
  [cars.id, unit(0, 0, 1)],
]);
const QUESTIONS = new Map<string, Float32Array>([
  ["tell me about cats", unit(1, 0.1, 0)],
  ["what has wheels", unit(0, 0.1, 1)],
]);

interface EmbedCall {
  readonly texts: readonly string[];
  readonly kind: EmbedKind;
}

function fakeEmbedder(dimensions = DIMENSIONS): Embedder & { calls: EmbedCall[] } {
  const calls: EmbedCall[] = [];
  return {
    modelId: "fake:model",
    dimensions,
    calls,
    embed: (texts, kind) => {
      calls.push({ texts: [...texts], kind });
      return Promise.resolve(
        texts.map((text) => {
          const vector = QUESTIONS.get(text);
          if (vector === undefined) throw new Error(`no fake vector for "${text}"`);
          return vector;
        }),
      );
    },
  };
}

async function build(
  options: { withChunks?: readonly Chunk[]; embedder?: Embedder; vectorStore?: VectorStore } = {},
) {
  const embedder = options.embedder ?? fakeEmbedder();
  const vectorStore = options.vectorStore ?? new FlatVectorStore(DIMENSIONS);
  const chunkStore: ChunkStore = new InMemoryChunkStore();
  const all = [cats, kittens, dogs, cars];
  await vectorStore.upsert(
    all.map((c) => ({ id: c.id, vector: VECTORS.get(c.id) as Float32Array, metadata: c.metadata })),
  );
  // the parent is stored but has no vector, like the parents of the parent-child chunker
  await chunkStore.put(options.withChunks ?? [...all, parent]);
  const retriever = new DenseRetriever({ embedder, vectorStore, chunkStore });
  return { retriever, embedder, vectorStore, chunkStore };
}

const ask = (text: string) => ({ text });

describe("DenseRetriever", () => {
  it("returns the nearest chunks first, with rank, score and the retriever name", async () => {
    const { retriever } = await build();
    const results = await retriever.retrieve(ask("tell me about cats"), { k: 3 });

    expect(results.map((r) => r.chunk)).toEqual([cats, kittens, dogs]);
    expect(results.map((r) => r.rank)).toEqual([1, 2, 3]);
    expect(results.every((r) => r.retriever === "dense")).toBe(true);
    const [first, second] = results;
    expect(first?.score).toBeGreaterThan(second?.score ?? 1);
    // scores are cosine similarities: the question and the first chunk differ only by a little
    expect(first?.score).toBeCloseTo(1 / Math.sqrt(1.01), 5);
  });

  it("finds a different chunk for a different question", async () => {
    const { retriever } = await build();
    const results = await retriever.retrieve(ask("what has wheels"), { k: 1 });
    expect(results.map((r) => r.chunk)).toEqual([cars]);
  });

  it("embeds the question once, as a query rather than a document", async () => {
    const { retriever, embedder } = await build();
    await retriever.retrieve(ask("tell me about cats"), { k: 2 });
    expect((embedder as ReturnType<typeof fakeEmbedder>).calls).toEqual([
      { texts: ["tell me about cats"], kind: "query" },
    ]);
  });

  it("returns fewer than k when the index has fewer chunks", async () => {
    const { retriever } = await build();
    expect(await retriever.retrieve(ask("tell me about cats"), { k: 50 })).toHaveLength(4);
  });

  it("never returns a chunk that has no vector, such as a parent", async () => {
    const { retriever } = await build();
    const results = await retriever.retrieve(ask("tell me about cats"), { k: 50 });
    expect(results.map((r) => r.chunk.id)).not.toContain(parent.id);
  });

  it("applies the filter before ranking, so k chunks come back when k exist", async () => {
    const { retriever } = await build();
    const onlyB: MetadataFilter = [{ kind: "equals", field: "docId", value: DOC_B }];
    const results = await retriever.retrieve(ask("tell me about cats"), { k: 2, filter: onlyB });
    // cats and kittens are far closer, but they are in document A
    expect(results.map((r) => r.chunk)).toEqual([dogs, cars]);
    expect(results.map((r) => r.rank)).toEqual([1, 2]);
  });

  it("returns an empty list from an empty index", async () => {
    const embedder = fakeEmbedder();
    const retriever = new DenseRetriever({
      embedder,
      vectorStore: new FlatVectorStore(DIMENSIONS),
      chunkStore: new InMemoryChunkStore(),
    });
    expect(await retriever.retrieve(ask("tell me about cats"), { k: 3 })).toEqual([]);
  });

  describe("when the stores disagree", () => {
    it("names the chunk id and says to rebuild when a vector has no chunk", async () => {
      const { retriever } = await build({ withChunks: [kittens, dogs, cars] });
      await expect(retriever.retrieve(ask("tell me about cats"), { k: 3 })).rejects.toMatchObject({
        code: "INTERNAL",
        message: expect.stringContaining(cats.id) as unknown,
      });
      await expect(retriever.retrieve(ask("tell me about cats"), { k: 3 })).rejects.toThrow(
        /pnpm index --force/,
      );
    });

    it("rejects an embedder and a store of different vector lengths, naming both", () => {
      expect(
        () =>
          new DenseRetriever({
            embedder: fakeEmbedder(8),
            vectorStore: new FlatVectorStore(DIMENSIONS),
            chunkStore: new InMemoryChunkStore(),
          }),
      ).toThrow(/fake:model.*8 numbers.*holds 3/);
    });
  });

  describe("errors", () => {
    it("does not call the embedder for an invalid k or a blank question", async () => {
      const { retriever, embedder } = await build();
      await expect(retriever.retrieve(ask("tell me about cats"), { k: 0 })).rejects.toThrow();
      await expect(retriever.retrieve(ask("  "), { k: 3 })).rejects.toThrow();
      expect((embedder as ReturnType<typeof fakeEmbedder>).calls).toHaveLength(0);
    });

    it("rejects an embedder that returns the wrong number of vectors", async () => {
      const { vectorStore, chunkStore } = await build();
      const broken: Embedder = { ...fakeEmbedder(), embed: () => Promise.resolve([]) };
      const retriever = new DenseRetriever({ embedder: broken, vectorStore, chunkStore });
      await expect(retriever.retrieve(ask("tell me about cats"), { k: 3 })).rejects.toMatchObject({
        code: "INTERNAL",
      });
    });

    it("passes on an error from the embedder unchanged", async () => {
      const { vectorStore, chunkStore } = await build();
      const down: Embedder = {
        ...fakeEmbedder(),
        embed: () => Promise.reject(new Error("Ollama is down")),
      };
      const retriever = new DenseRetriever({ embedder: down, vectorStore, chunkStore });
      await expect(retriever.retrieve(ask("tell me about cats"), { k: 3 })).rejects.toThrow(
        "Ollama is down",
      );
    });
  });
});

describeRetrieverContract("DenseRetriever", async () => ({
  retriever: (await build()).retriever,
  query: ask("tell me about cats"),
  filter: [{ kind: "equals", field: "docId", value: DOC_B }],
  allowed: (c) => c.metadata.docId === DOC_B,
}));

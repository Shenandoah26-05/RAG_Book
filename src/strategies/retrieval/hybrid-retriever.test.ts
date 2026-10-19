import { describe, expect, it, vi } from "vitest";
import { makeChunkId } from "../../core/index.js";
import type {
  Chunk,
  DocId,
  Embedder,
  MetadataFilter,
  Retriever,
  RetrieveOptions,
} from "../../core/index.js";
import { makeDocId } from "../../shared/index.js";
import { describeRetrieverContract } from "../../testing/retriever-contract.testing.js";
import { FlatVectorStore, InMemoryChunkStore } from "../in-memory-index/index.js";
import { Bm25Index } from "../keyword/index.js";
import { Bm25Retriever } from "./bm25-retriever.js";
import { DenseRetriever } from "./dense-retriever.js";
import { HybridRetriever } from "./hybrid-retriever.js";
import { RrfFusion } from "./rrf-fusion.js";
import { WeightedFusion } from "./weighted-fusion.js";

const DOC_A = makeDocId("a".repeat(64));
const DOC_B = makeDocId("b".repeat(64));

function unit(...v: number[]): Float32Array {
  const length = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return Float32Array.from(v.map((x) => x / length));
}

function chunk(docId: DocId, text: string, start: number): Chunk {
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
      pageStart: 1,
      pageEnd: 1,
      sectionPath: [],
      charStart: start,
      charEnd: start + text.length,
      strategy: "recursive",
    },
  };
}

// For the question "cats", the two rankings differ on purpose:
//   keyword (words):   purr first (short, "cats" once), then young, then furry (long)
//   dense (meaning):   young, then dogs, then furry, then purr, then cars
const purr = chunk(DOC_A, "cats purr", 0);
const young = chunk(DOC_A, "kittens are young cats", 10);
const dogs = chunk(DOC_B, "dogs bark and fetch", 0);
const cars = chunk(DOC_B, "cars have four wheels", 30);
const furry = chunk(DOC_B, "furry animals such as cats like to sleep all day long", 60);
const ALL = [purr, young, dogs, cars, furry];

const VECTORS = new Map<string, Float32Array>([
  [young.id, unit(1, 0.1, 0)],
  [dogs.id, unit(0.8, 0.6, 0)],
  [furry.id, unit(0.6, 0.8, 0)],
  [purr.id, unit(0.2, 1, 0)],
  [cars.id, unit(0, 0, 1)],
]);
const embedder: Embedder = {
  modelId: "fake:model",
  dimensions: 3,
  embed: (texts) => Promise.resolve(texts.map(() => unit(1, 0, 0))),
};

async function parts() {
  const chunkStore = new InMemoryChunkStore();
  await chunkStore.put(ALL);
  const vectorStore = new FlatVectorStore(3);
  await vectorStore.upsert(
    ALL.map((c) => ({ id: c.id, vector: VECTORS.get(c.id) as Float32Array, metadata: c.metadata })),
  );
  const index = new Bm25Index();
  index.add(ALL);
  return {
    dense: new DenseRetriever({ embedder, vectorStore, chunkStore }),
    keyword: new Bm25Retriever(index, chunkStore),
  };
}

const ask = (text: string) => ({ text });
const texts = (results: readonly { chunk: Chunk }[]): string[] => results.map((r) => r.chunk.text);

describe("Bm25Retriever", () => {
  it("returns the chunks that share words with the question, with rank, score and name", async () => {
    const { keyword } = await parts();
    const results = await keyword.retrieve(ask("cats"), { k: 10 });
    expect(texts(results)).toEqual([purr.text, young.text, furry.text]);
    expect(results.map((r) => r.rank)).toEqual([1, 2, 3]);
    expect(results.every((r) => r.retriever === "bm25")).toBe(true);
    expect(results[0]?.score).toBeGreaterThan(results[1]?.score ?? 1);
  });

  it("gives an empty list for a question with no usable words or no match", async () => {
    const { keyword } = await parts();
    expect(await keyword.retrieve(ask("zebra"), { k: 3 })).toEqual([]);
  });

  it("names the chunk id when the index has a chunk the store does not", async () => {
    const index = new Bm25Index();
    index.add([purr]);
    const retriever = new Bm25Retriever(index, new InMemoryChunkStore());
    await expect(retriever.retrieve(ask("cats"), { k: 3 })).rejects.toThrow(
      new RegExp(`${purr.id}.*pnpm index --force`),
    );
  });
});

describeRetrieverContract("Bm25Retriever", async () => ({
  retriever: (await parts()).keyword,
  query: ask("cats"),
  filter: [{ kind: "equals", field: "docId", value: DOC_B }],
  allowed: (c) => c.metadata.docId === DOC_B,
}));

describe("HybridRetriever", () => {
  it("combines the rankings of its retrievers with the fusion strategy", async () => {
    const { dense, keyword } = await parts();
    const hybrid = new HybridRetriever({ retrievers: [dense, keyword], fusion: new RrfFusion() });
    const results = await hybrid.retrieve(ask("cats"), { k: 5 });

    // dense: young, dogs, furry, purr, cars   keyword: purr, young, furry
    // young: 1/61 + 1/62   purr: 1/64 + 1/61   furry: 1/63 + 1/63   dogs: 1/62   cars: 1/65
    expect(texts(results)).toEqual([young.text, purr.text, furry.text, dogs.text, cars.text]);
    expect(results.map((r) => r.rank)).toEqual([1, 2, 3, 4, 5]);
    expect(results.every((r) => r.retriever === "hybrid")).toBe(true);
    expect(results[0]?.score).toBeCloseTo(1 / 61 + 1 / 62, 12);
    // the chunks are the real ones from the retrievers
    expect(results[0]?.chunk).toEqual(young);
  });

  it("finds what only one retriever finds: a chunk with no shared word, and one with no meaning match", async () => {
    const { dense, keyword } = await parts();
    const results = await new HybridRetriever({
      retrievers: [dense, keyword],
      fusion: new RrfFusion(),
    }).retrieve(ask("cats"), { k: 5 });
    expect(texts(results)).toContain(dogs.text); // dense only
    expect((await keyword.retrieve(ask("cats"), { k: 10 })).map((r) => r.chunk.text)).not.toContain(
      dogs.text,
    );
  });

  it("returns at most k, the best of the fused ranking", async () => {
    const { dense, keyword } = await parts();
    const hybrid = new HybridRetriever({ retrievers: [dense, keyword], fusion: new RrfFusion() });
    expect(texts(await hybrid.retrieve(ask("cats"), { k: 2 }))).toEqual([young.text, purr.text]);
  });

  it("works with a weighted fusion, and with a single retriever", async () => {
    const { dense, keyword } = await parts();
    const weighted = new HybridRetriever({
      retrievers: [dense, keyword],
      fusion: new WeightedFusion({ dense: 1, bm25: 0 }),
    });
    expect(texts(await weighted.retrieve(ask("cats"), { k: 3 }))).toEqual(
      texts(await dense.retrieve(ask("cats"), { k: 3 })),
    );
    const single = new HybridRetriever({ retrievers: [keyword], fusion: new RrfFusion() });
    expect(texts(await single.retrieve(ask("cats"), { k: 3 }))).toEqual(
      texts(await keyword.retrieve(ask("cats"), { k: 3 })),
    );
  });

  it("applies the filter to every retriever", async () => {
    const { dense, keyword } = await parts();
    const onlyB: MetadataFilter = [{ kind: "equals", field: "docId", value: DOC_B }];
    const results = await new HybridRetriever({
      retrievers: [dense, keyword],
      fusion: new RrfFusion(),
    }).retrieve(ask("cats"), { k: 10, filter: onlyB });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.chunk.metadata.docId === DOC_B)).toBe(true);
  });

  describe("how many chunks each retriever is asked for", () => {
    function spy(name: string): Retriever & { asked: RetrieveOptions[] } {
      const asked: RetrieveOptions[] = [];
      return {
        name,
        asked,
        retrieve: (_query, options) => {
          asked.push(options);
          return Promise.resolve([]);
        },
      };
    }

    it("asks for max(k, depth), 50 unless set, and passes the filter on", async () => {
      const a = spy("a");
      const b = spy("b");
      const filter: MetadataFilter = [{ kind: "pageRange", from: 2 }];
      await new HybridRetriever({ retrievers: [a, b], fusion: new RrfFusion() }).retrieve(
        ask("q"),
        {
          k: 5,
          filter,
        },
      );
      expect(a.asked).toEqual([{ k: 50, filter }]);
      expect(b.asked).toEqual([{ k: 50, filter }]);

      const c = spy("c");
      const hybrid = new HybridRetriever({ retrievers: [c], fusion: new RrfFusion(), depth: 10 });
      await hybrid.retrieve(ask("q"), { k: 5 });
      await hybrid.retrieve(ask("q"), { k: 30 });
      expect(c.asked).toEqual([{ k: 10 }, { k: 30 }]);
    });

    it("lets a chunk that is second in both rankings win, but only if the second place is fetched", async () => {
      const x = chunk(DOC_A, "first in dense", 0);
      const y = chunk(DOC_A, "first in keyword", 20);
      const both = chunk(DOC_A, "second in both", 40);
      const make = (name: string, found: Chunk[]): Retriever => ({
        name,
        retrieve: (_q, { k }) =>
          Promise.resolve(
            found
              .slice(0, k)
              .map((c, i) => ({ chunk: c, score: 100 - i, rank: i + 1, retriever: name })),
          ),
      });
      const retrievers = [make("dense", [x, both]), make("keyword", [y, both])];
      const at = (depth: number) =>
        new HybridRetriever({ retrievers, fusion: new RrfFusion(), depth }).retrieve(ask("q"), {
          k: 1,
        });
      // both: 1/62 + 1/62 beats x and y, 1/61 each
      expect((await at(2))[0]?.chunk).toEqual(both);
      // asked for only 1 each, the retrievers never mention it
      expect((await at(1))[0]?.chunk).not.toEqual(both);
    });
  });

  describe("errors", () => {
    it("fails the whole query when one retriever fails, with that error", async () => {
      const { dense } = await parts();
      const broken: Retriever = {
        name: "broken",
        retrieve: () => Promise.reject(new Error("index is gone")),
      };
      const hybrid = new HybridRetriever({ retrievers: [dense, broken], fusion: new RrfFusion() });
      await expect(hybrid.retrieve(ask("cats"), { k: 3 })).rejects.toThrow("index is gone");
    });

    it("rejects a bad k or blank question before asking any retriever", async () => {
      const retrieve = vi.fn(() => Promise.resolve([]));
      const hybrid = new HybridRetriever({
        retrievers: [{ name: "x", retrieve }],
        fusion: new RrfFusion(),
      });
      await expect(hybrid.retrieve(ask("q"), { k: 0 })).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
      });
      await expect(hybrid.retrieve(ask(" "), { k: 3 })).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
      });
      expect(retrieve).not.toHaveBeenCalled();
    });

    it("rejects no retrievers, repeated names and a bad depth when built", async () => {
      const { dense, keyword } = await parts();
      const fusion = new RrfFusion();
      expect(() => new HybridRetriever({ retrievers: [], fusion })).toThrow(/at least one/);
      expect(() => new HybridRetriever({ retrievers: [dense, dense], fusion })).toThrow(
        /Two retrievers are called "dense"/,
      );
      expect(() => new HybridRetriever({ retrievers: [keyword], fusion, depth: 0 })).toThrow(
        /depth must be a whole number/,
      );
    });
  });

  it("can be one of the retrievers of another hybrid", async () => {
    const { dense, keyword } = await parts();
    const inner = new HybridRetriever({ retrievers: [dense, keyword], fusion: new RrfFusion() });
    const outer = new HybridRetriever({ retrievers: [inner], fusion: new RrfFusion() });
    expect(texts(await outer.retrieve(ask("cats"), { k: 3 }))).toEqual(
      texts(await inner.retrieve(ask("cats"), { k: 3 })),
    );
  });
});

for (const [label, fusion] of [
  ["RRF", new RrfFusion()],
  ["weighted", new WeightedFusion({ dense: 0.6, bm25: 0.4 })],
] as const) {
  describeRetrieverContract(`HybridRetriever (${label})`, async () => {
    const { dense, keyword } = await parts();
    return {
      retriever: new HybridRetriever({ retrievers: [dense, keyword], fusion }),
      query: ask("cats"),
      filter: [{ kind: "equals", field: "docId", value: DOC_B }],
      allowed: (c) => c.metadata.docId === DOC_B,
    };
  });
}

import { describe, expect, it, vi } from "vitest";
import { makeChunkId } from "../../core/index.js";
import type {
  Chunk,
  ChunkStore,
  DocId,
  Embedder,
  MetadataFilter,
  Query,
  RetrieveOptions,
  RetrievedChunk,
  Retriever,
} from "../../core/index.js";
import { RagError, makeDocId } from "../../shared/index.js";
import { describeRetrieverContract } from "../../testing/retriever-contract.testing.js";
import { FlatVectorStore, InMemoryChunkStore } from "../in-memory-index/index.js";
import { DenseRetriever } from "./dense-retriever.js";
import { ParentExpandingRetriever } from "./parent-expanding-retriever.js";

const DOC_A = makeDocId("a".repeat(64));
const DOC_B = makeDocId("b".repeat(64));

function unit(...v: number[]): Float32Array {
  const length = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return Float32Array.from(v.map((x) => x / length));
}

function chunk(
  docId: DocId,
  strategy: string,
  text: string,
  start: number,
  pages: [number, number],
  parentId?: Chunk["id"],
): Chunk {
  return {
    id: makeChunkId({ docId, strategy, charStart: start, charEnd: start + text.length, text }),
    text,
    ...(parentId === undefined ? {} : { parentId }),
    metadata: {
      docId,
      pageStart: pages[0],
      pageEnd: pages[1],
      sectionPath: [],
      charStart: start,
      charEnd: start + text.length,
      strategy,
    },
  };
}

// Three parents (stored, never searched) and the children cut from them.
const parentOne = chunk(DOC_A, "parent", "Chapter text about cats and kittens.", 0, [10, 14]);
const parentTwo = chunk(DOC_A, "parent", "Chapter text about dogs.", 100, [15, 16]);
const parentThree = chunk(DOC_B, "parent", "Chapter text about wheels.", 0, [1, 3]);

const catsA = chunk(DOC_A, "child", "Cats purr.", 0, [12, 12], parentOne.id);
const catsB = chunk(DOC_A, "child", "Kittens are young cats.", 40, [13, 13], parentOne.id);
const dogs = chunk(DOC_A, "child", "Dogs bark.", 100, [15, 15], parentTwo.id);
const cars = chunk(DOC_B, "child", "Cars have wheels.", 0, [2, 2], parentThree.id);
const plain = chunk(DOC_B, "recursive", "A chunk from a plain chunker.", 200, [5, 5]);

const VECTORS = new Map<string, Float32Array>([
  [catsA.id, unit(1, 0)],
  [dogs.id, unit(0.9, 0.4)],
  [catsB.id, unit(0.8, 0.6)],
  [cars.id, unit(0.5, 0.9)],
  [plain.id, unit(0, 1)],
]);

const embedder: Embedder = {
  modelId: "fake:model",
  dimensions: 2,
  embed: (texts) => Promise.resolve(texts.map(() => unit(1, 0))),
};

async function build() {
  const vectorStore = new FlatVectorStore(2);
  const children = [catsA, catsB, dogs, cars, plain];
  await vectorStore.upsert(
    children.map((c) => ({
      id: c.id,
      vector: VECTORS.get(c.id) as Float32Array,
      metadata: c.metadata,
    })),
  );
  const chunkStore: ChunkStore = new InMemoryChunkStore();
  await chunkStore.put([...children, parentOne, parentTwo, parentThree]);
  const dense = new DenseRetriever({ embedder, vectorStore, chunkStore });
  const retriever = new ParentExpandingRetriever({ inner: dense, chunkStore });
  return { retriever, dense, chunkStore };
}

const ask: Query = { text: "tell me about cats" };
const ids = (results: readonly RetrievedChunk[]): string[] => results.map((r) => r.chunk.id);

describe("ParentExpandingRetriever", () => {
  it("replaces each child with its parent, best child first", async () => {
    const { retriever } = await build();
    const results = await retriever.retrieve(ask, { k: 10 });
    // catsA (1.0) -> parentOne, dogs -> parentTwo, catsB merges into parentOne, cars -> parentThree
    expect(ids(results)).toEqual([parentOne.id, parentTwo.id, parentThree.id, plain.id]);
    expect(results.map((r) => r.rank)).toEqual([1, 2, 3, 4]);
  });

  it("merges children of one parent and keeps the best child's score", async () => {
    const { retriever, dense } = await build();
    const children = await dense.retrieve(ask, { k: 10 });
    const results = await retriever.retrieve(ask, { k: 10 });
    expect(results[0]?.score).toBe(children.find((r) => r.chunk.id === catsA.id)?.score);
    expect(results.filter((r) => r.chunk.id === parentOne.id)).toHaveLength(1);
  });

  it("returns chunks without a parent unchanged, mixed in by score", async () => {
    const { retriever } = await build();
    const results = await retriever.retrieve(ask, { k: 10 });
    expect(results.at(-1)?.chunk).toEqual(plain);
  });

  it("does nothing to an index that has no parents", async () => {
    const { dense, chunkStore } = await build();
    const wrapper = new ParentExpandingRetriever({ inner: dense, chunkStore });
    const onlyPlain: MetadataFilter = [{ kind: "equals", field: "strategy", value: "recursive" }];
    const results = await wrapper.retrieve(ask, { k: 5, filter: onlyPlain });
    expect(results.map((r) => r.chunk)).toEqual([plain]);
  });

  it("names itself after the retriever it wraps, in every result", async () => {
    const { retriever } = await build();
    expect(retriever.name).toBe("dense+parents");
    const results = await retriever.retrieve(ask, { k: 3 });
    expect(results.every((r) => r.retriever === "dense+parents")).toBe(true);
  });

  it("returns fewer than k when children share a parent, never more", async () => {
    const { retriever } = await build();
    // the top 2 children are catsA and dogs; the top 3 add catsB, whose parent is already there
    expect(await retriever.retrieve(ask, { k: 3 })).toHaveLength(2);
    expect(await retriever.retrieve(ask, { k: 1 })).toHaveLength(1);
  });

  it("looks all the parents up in one ChunkStore call", async () => {
    const { chunkStore } = await build();
    const get = vi.spyOn(chunkStore, "get");
    const found = [catsA, catsB, dogs].map((c, i) => ({
      chunk: c,
      score: 1 - i * 0.1,
      rank: i + 1,
      retriever: "stub",
    }));
    const inner: Retriever = { name: "stub", retrieve: () => Promise.resolve(found) };
    await new ParentExpandingRetriever({ inner, chunkStore }).retrieve(ask, { k: 10 });
    // one call, for the two different parents (not three, one per child)
    expect(get.mock.calls).toEqual([[[parentOne.id, parentTwo.id]]]);
  });

  it("gives the inner retriever the question, k and the filter unchanged", async () => {
    const seen: [Query, RetrieveOptions][] = [];
    const inner: Retriever = {
      name: "spy",
      retrieve: (query, options) => {
        seen.push([query, options]);
        return Promise.resolve([]);
      },
    };
    const filter: MetadataFilter = [{ kind: "pageRange", from: 12 }];
    const wrapper = new ParentExpandingRetriever({ inner, chunkStore: new InMemoryChunkStore() });
    expect(await wrapper.retrieve(ask, { k: 4, filter })).toEqual([]);
    expect(seen).toEqual([[ask, { k: 4, filter }]]);
  });

  it("returns a parent that reaches outside the filter, as the context of a matching child", async () => {
    const { retriever } = await build();
    const page12: MetadataFilter = [{ kind: "pageRange", from: 12, to: 12 }];
    const results = await retriever.retrieve(ask, { k: 5, filter: page12 });
    expect(results.map((r) => r.chunk)).toEqual([parentOne]);
    expect(parentOne.metadata.pageStart).toBeLessThan(12); // the parent starts before the filter
  });

  it("fails with INTERNAL, naming the parent, when a parent is missing from the store", async () => {
    const { dense } = await build();
    const emptyStore = new InMemoryChunkStore();
    const wrapper = new ParentExpandingRetriever({ inner: dense, chunkStore: emptyStore });
    const error = await wrapper.retrieve(ask, { k: 3 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RagError);
    expect((error as RagError).code).toBe("INTERNAL");
    expect((error as RagError).message).toContain(parentOne.id);
  });

  it("passes the inner retriever's errors through", async () => {
    const { retriever } = await build();
    await expect(retriever.retrieve(ask, { k: 0 })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  });
});

describeRetrieverContract("ParentExpandingRetriever", async () => ({
  retriever: (await build()).retriever,
  query: ask,
  filter: [{ kind: "equals", field: "docId", value: DOC_B }],
  allowed: (c) => c.metadata.docId === DOC_B,
}));

import { describe, expect, it } from "vitest";
import type { ChunkId, ChunkMetadata, DocId, VectorRecord } from "../../core/index.js";
import { RagError } from "../../shared/index.js";
import { describeVectorStoreContract } from "../../testing/vector-store-contract.testing.js";
import { FlatVectorStore } from "./flat-vector-store.js";

describeVectorStoreContract("FlatVectorStore", (dimensions) => new FlatVectorStore(dimensions));

const meta: ChunkMetadata = {
  docId: "doc" as DocId,
  pageStart: 1,
  pageEnd: 1,
  sectionPath: [],
  charStart: 0,
  charEnd: 1,
  strategy: "recursive",
};
const record = (id: string, ...values: number[]): VectorRecord => ({
  id: id as ChunkId,
  vector: Float32Array.from(values),
  metadata: meta,
});

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return error instanceof RagError ? error.code : "not a RagError";
  }
  return undefined;
}

describe("FlatVectorStore: scores", () => {
  it("scores by cosine similarity even when the vectors are not unit length", async () => {
    const store = new FlatVectorStore(2);
    await store.upsert([record("same", 3, 0), record("half", 1, 1), record("other", 0, 5)]);
    const hits = await store.search(Float32Array.from([10, 0]), 3);
    expect(hits.map((h) => h.id)).toEqual(["same", "half", "other"]);
    expect(hits[0]?.score).toBeCloseTo(1, 6);
    expect(hits[1]?.score).toBeCloseTo(Math.SQRT1_2, 6);
    expect(hits[2]?.score).toBeCloseTo(0, 6);
  });

  it("scores a zero vector 0, never NaN", async () => {
    const store = new FlatVectorStore(2);
    await store.upsert([record("zero", 0, 0), record("x", 1, 0)]);
    const hits = await store.search(Float32Array.from([1, 0]), 2);
    expect(hits.map((h) => h.score)).toEqual([1, 0]);
    expect((await store.search(Float32Array.from([0, 0]), 2)).map((h) => h.score)).toEqual([0, 0]);
  });
});

describe("FlatVectorStore: protecting the index", () => {
  it("keeps its own copy of a vector, so changing the original array changes nothing", async () => {
    const store = new FlatVectorStore(2);
    const vector = Float32Array.from([1, 0]);
    await store.upsert([{ id: "a" as ChunkId, vector, metadata: meta }]);
    vector.set([0, 1]);
    const hits = await store.search(Float32Array.from([1, 0]), 1);
    expect(hits[0]?.score).toBeCloseTo(1, 6);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY])("rejects a vector holding %s", async (bad) => {
    const store = new FlatVectorStore(2);
    expect(await codeOf(store.upsert([record("a", 1, bad)]))).toBe("INVALID_ARGUMENT");
    expect(await codeOf(store.search(Float32Array.from([bad, 1]), 1))).toBe("INVALID_ARGUMENT");
    expect(await store.count()).toBe(0);
  });

  it("stores nothing from a batch that has an invalid record", async () => {
    const store = new FlatVectorStore(2);
    expect(await codeOf(store.upsert([record("ok", 1, 0), record("bad", 1, 0, 0)]))).toBe(
      "INVALID_ARGUMENT",
    );
    expect(await store.count()).toBe(0);
  });
});

describe("FlatVectorStore: exact search on more data", () => {
  it("gives the same hits as scoring and sorting every vector", async () => {
    const dims = 16;
    let state = 7;
    const next = (): number => {
      state = (state * 1664525 + 1013904223) % 4294967296;
      return state / 4294967296 - 0.5;
    };
    const records = Array.from({ length: 500 }, (_, n) =>
      record(`r${n.toString().padStart(3, "0")}`, ...Array.from({ length: dims }, next)),
    );
    const store = new FlatVectorStore(dims);
    await store.upsert(records);
    const query = Float32Array.from({ length: dims }, next);

    const length = (v: Float32Array): number => Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    const cosine = (v: Float32Array): number =>
      v.reduce((s, x, i) => s + x * (query[i] ?? 0), 0) / (length(v) * length(query));
    const expected = records
      .map((r) => ({ id: r.id, score: cosine(r.vector) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);

    const hits = await store.search(query, 10);
    expect(hits.map((h) => h.id)).toEqual(expected.map((h) => h.id));
    hits.forEach((h, i) => {
      expect(h.score).toBeCloseTo(expected[i]?.score ?? Number.NaN, 5);
    });
  });
});

describe("FlatVectorStore: constructor", () => {
  it.each([0, -3, 2.5, Number.NaN])("rejects dimensions = %s", (dimensions) => {
    expect(() => new FlatVectorStore(dimensions)).toThrow(/dimensions must be a whole number/);
  });
});

describe("FlatVectorStore: records()", () => {
  it("lists every record in insertion order; a replaced id keeps its place", async () => {
    const store = new FlatVectorStore(2);
    await store.upsert([record("b", 1, 0), record("a", 0, 1), record("c", 1, 1)]);
    await store.upsert([record("b", 5, 5)]);
    await store.delete(["c" as ChunkId]);

    const listed = [...store.records()];
    expect(listed.map((r) => r.id)).toEqual(["b", "a"]);
    expect(Array.from(listed[0]?.vector ?? [])).toEqual([5, 5]);
    expect(listed[1]?.metadata).toEqual(meta);
  });

  it("lists nothing for an empty store", () => {
    expect([...new FlatVectorStore(2).records()]).toEqual([]);
  });
});

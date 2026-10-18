import { describe, expect, it } from "vitest";
import type {
  ChunkId,
  ChunkMetadata,
  DocId,
  MetadataFilter,
  VectorRecord,
} from "../../core/index.js";
import { RagError } from "../../shared/index.js";
import { describeVectorStoreContract } from "../../testing/vector-store-contract.testing.js";
import { FlatVectorStore } from "./flat-vector-store.js";
import { HnswVectorStore } from "./hnsw-vector-store.js";

describeVectorStoreContract("HnswVectorStore", (dimensions) => new HnswVectorStore(dimensions));

const meta = (docId: string, page: number): ChunkMetadata => ({
  docId: docId as DocId,
  pageStart: page,
  pageEnd: page,
  sectionPath: [],
  charStart: 0,
  charEnd: 1,
  strategy: "recursive",
});

function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function corpus(n: number, dimensions: number, seed: number): VectorRecord[] {
  const next = random(seed);
  return Array.from({ length: n }, (_, i) => ({
    id: `c${i.toString().padStart(5, "0")}` as ChunkId,
    vector: Float32Array.from({ length: dimensions }, () => next() - 0.5),
    metadata: meta(i % 2 === 0 ? "even" : "odd", 1 + (i % 50)),
  }));
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return error instanceof RagError ? error.code : "not a RagError";
  }
  return undefined;
}

describe("HnswVectorStore: options", () => {
  it.each([
    [() => new HnswVectorStore(0)],
    [() => new HnswVectorStore(4, { m: 1 })],
    [() => new HnswVectorStore(4, { efConstruction: 0 })],
    [() => new HnswVectorStore(4, { efSearch: 1.5 })],
  ])("rejects options that are not whole numbers in range", (make) => {
    expect(make).toThrow(RagError);
  });

  it("lets efSearch be changed, and validates it", () => {
    const store = new HnswVectorStore(4);
    store.efSearch = 10;
    expect(store.efSearch).toBe(10);
    expect(() => {
      store.efSearch = 0;
    }).toThrow(RagError);
  });
});

describe("HnswVectorStore: approximate search against the exact one", () => {
  const records = corpus(1500, 24, 7);
  const queries = corpus(40, 24, 99).map((r) => r.vector);
  const query = (n: number): Float32Array => queries[n] ?? new Float32Array(24);

  async function build(): Promise<{ hnsw: HnswVectorStore; flat: FlatVectorStore }> {
    const hnsw = new HnswVectorStore(24);
    const flat = new FlatVectorStore(24);
    await hnsw.upsert(records);
    await flat.upsert(records);
    return { hnsw, flat };
  }

  async function recall(
    hnsw: HnswVectorStore,
    flat: FlatVectorStore,
    filter?: MetadataFilter,
  ): Promise<number> {
    let hit = 0;
    for (const q of queries) {
      const truth = new Set((await flat.search(q, 10, filter)).map((h) => h.id));
      const got = await hnsw.search(q, 10, filter);
      hit += got.filter((h) => truth.has(h.id)).length;
    }
    return hit / (queries.length * 10);
  }

  it("finds nearly all of the true top 10 (recall@10 >= 0.95)", async () => {
    const { hnsw, flat } = await build();
    expect(await recall(hnsw, flat)).toBeGreaterThanOrEqual(0.95);
  });

  it("compares the query with far fewer vectors than a full scan", async () => {
    const { hnsw } = await build();
    hnsw.efSearch = 16; // random vectors have no clusters to exploit, so keep the search narrow
    const before = hnsw.comparisons;
    await hnsw.search(query(0), 10);
    expect(hnsw.comparisons - before).toBeLessThan(records.length / 2);
  });

  it("returns scores equal to the exact cosine for the hits it returns", async () => {
    const { hnsw, flat } = await build();
    const exact = new Map(
      (await flat.search(query(1), records.length)).map((h) => [h.id, h.score]),
    );
    for (const hit of await hnsw.search(query(1), 10)) {
      expect(hit.score).toBeCloseTo(exact.get(hit.id) ?? Number.NaN, 5);
    }
  });

  it("keeps its recall with a filter, and every hit satisfies it", async () => {
    const { hnsw, flat } = await build();
    const filter: MetadataFilter = [{ kind: "equals", field: "docId", value: "odd" }];
    expect(await recall(hnsw, flat, filter)).toBeGreaterThanOrEqual(0.95);
    const hits = await hnsw.search(query(2), 10, filter);
    expect(hits).toHaveLength(10);
    expect(hits.every((h) => Number(h.id.slice(1)) % 2 === 1)).toBe(true);
  });

  it("gives the exact answer for a filter that few chunks satisfy", async () => {
    const { hnsw, flat } = await build();
    const filter: MetadataFilter = [{ kind: "pageRange", from: 50, to: 50 }]; // 30 of 1500 chunks
    const got = await hnsw.search(query(3), 10, filter);
    expect(got.map((h) => h.id)).toEqual(
      (await flat.search(query(3), 10, filter)).map((h) => h.id),
    );
  });

  it("builds the same graph, so gives the same hits, every time", async () => {
    const a = (await build()).hnsw;
    const b = (await build()).hnsw;
    expect(await a.search(query(4), 10)).toEqual(await b.search(query(4), 10));
  });

  it("raising efSearch never lowers recall", async () => {
    const { hnsw, flat } = await build();
    hnsw.efSearch = 10;
    const low = await recall(hnsw, flat);
    hnsw.efSearch = 200;
    expect(await recall(hnsw, flat)).toBeGreaterThanOrEqual(low);
  });
});

describe("HnswVectorStore: changing the index", () => {
  it("never returns a deleted or replaced record, and keeps working after the rebuild", async () => {
    const records = corpus(300, 8, 3);
    const hnsw = new HnswVectorStore(8);
    const flat = new FlatVectorStore(8);
    await hnsw.upsert(records);
    await flat.upsert(records);

    const gone = records.slice(0, 200).map((r) => r.id); // more than half: forces a rebuild
    await hnsw.delete(gone);
    await flat.delete(gone);
    expect(await hnsw.count()).toBe(100);

    const probe = records[250]?.vector ?? new Float32Array(8);
    const hits = await hnsw.search(probe, 10);
    expect(hits.some((h) => gone.includes(h.id))).toBe(false);
    expect(hits.map((h) => h.id)).toEqual((await flat.search(probe, 10)).map((h) => h.id));

    // replacing an id moves it to its new vector
    const original = records[250];
    if (original === undefined) throw new Error("fixture missing");
    const moved: VectorRecord = {
      ...original,
      vector: Float32Array.from([1, 0, 0, 0, 0, 0, 0, 0]),
    };
    await hnsw.upsert([moved]);
    expect((await hnsw.search(moved.vector, 1))[0]?.id).toBe(moved.id);
    expect(await hnsw.count()).toBe(100);
  });

  it("can be emptied and reused", async () => {
    const records = corpus(20, 4, 5);
    const hnsw = new HnswVectorStore(4);
    await hnsw.upsert(records);
    await hnsw.delete(records.map((r) => r.id));
    expect(await hnsw.count()).toBe(0);
    expect(await hnsw.search(Float32Array.from([1, 0, 0, 0]), 3)).toEqual([]);
    await hnsw.upsert(records.slice(0, 2));
    expect(await hnsw.search(Float32Array.from([1, 0, 0, 0]), 3)).toHaveLength(2);
  });

  it("rejects bad input and stores nothing from a bad batch", async () => {
    const hnsw = new HnswVectorStore(3);
    const ok = { id: "a" as ChunkId, vector: Float32Array.from([1, 0, 0]), metadata: meta("d", 1) };
    const bad = { ...ok, id: "b" as ChunkId, vector: Float32Array.from([1, Number.NaN, 0]) };
    expect(await codeOf(hnsw.upsert([ok, bad]))).toBe("INVALID_ARGUMENT");
    expect(await hnsw.count()).toBe(0);
    expect(await codeOf(hnsw.search(Float32Array.from([1, 0]), 1))).toBe("INVALID_ARGUMENT");
    expect(await codeOf(hnsw.search(Float32Array.from([1, 0, 0]), 0))).toBe("INVALID_ARGUMENT");
  });

  it("scores a zero vector 0, never NaN", async () => {
    const hnsw = new HnswVectorStore(2);
    const at = (id: string, ...v: number[]): VectorRecord => ({
      id: id as ChunkId,
      vector: Float32Array.from(v),
      metadata: meta("d", 1),
    });
    await hnsw.upsert([at("zero", 0, 0), at("x", 1, 0)]);
    expect((await hnsw.search(Float32Array.from([3, 0]), 2)).map((h) => h.score)).toEqual([1, 0]);
  });
});

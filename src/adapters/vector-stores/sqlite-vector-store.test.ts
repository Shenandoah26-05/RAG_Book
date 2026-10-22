import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { ChunkId, ChunkMetadata, DocId, VectorRecord } from "../../core/index.js";
import { RagError } from "../../shared/index.js";
import { describeVectorStoreContract } from "../../testing/vector-store-contract.testing.js";
import { SqliteVectorStore } from "./sqlite-vector-store.js";

// The same contract FlatVectorStore passes: this is the proof the port holds for a real database.
describeVectorStoreContract("SqliteVectorStore", (dimensions) => new SqliteVectorStore(dimensions));

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

const folders: string[] = [];
async function tempFile(): Promise<string> {
  const folder = await mkdtemp(path.join(os.tmpdir(), "rag-sqlite-"));
  folders.push(folder);
  return path.join(folder, "nested", "vectors.sqlite");
}
afterAll(async () => {
  await Promise.all(folders.map((f) => rm(f, { recursive: true, force: true })));
});

describe("SqliteVectorStore: scores", () => {
  it("scores by cosine similarity even when the vectors are not unit length", async () => {
    const store = new SqliteVectorStore(2);
    await store.upsert([record("same", 3, 0), record("half", 1, 1), record("other", 0, 5)]);
    const hits = await store.search(Float32Array.from([10, 0]), 3);
    expect(hits.map((h) => h.id)).toEqual(["same", "half", "other"]);
    expect(hits[0]?.score).toBeCloseTo(1, 6);
    expect(hits[1]?.score).toBeCloseTo(Math.SQRT1_2, 6);
    store.close();
  });

  it("scores a vector with no length as 0, never NaN", async () => {
    const store = new SqliteVectorStore(2);
    await store.upsert([record("zero", 0, 0), record("x", 1, 0)]);
    const hits = await store.search(Float32Array.from([1, 0]), 2);
    expect(hits.map((h) => [h.id, h.score])).toEqual([
      ["x", expect.closeTo(1, 6)],
      ["zero", 0],
    ]);
    store.close();
  });

  it("orders identical vectors by id", async () => {
    const store = new SqliteVectorStore(2);
    await store.upsert([record("b", 1, 0), record("a", 1, 0), record("c", 1, 0)]);
    const hits = await store.search(Float32Array.from([1, 0]), 3);
    expect(hits.map((h) => h.id)).toEqual(["a", "b", "c"]);
    store.close();
  });
});

describe("SqliteVectorStore: bad input", () => {
  it("rejects a bad dimension count when created", () => {
    expect(() => new SqliteVectorStore(0)).toThrow(RagError);
    expect(() => new SqliteVectorStore(1.5)).toThrow(RagError);
  });

  it("rejects NaN and Infinity, and stores nothing from that batch", async () => {
    const store = new SqliteVectorStore(2);
    expect(await codeOf(store.upsert([record("ok", 1, 0), record("bad", Number.NaN, 0)]))).toBe(
      "INVALID_ARGUMENT",
    );
    expect(await store.count()).toBe(0);
    expect(await codeOf(store.search(Float32Array.from([Infinity, 0]), 1))).toBe(
      "INVALID_ARGUMENT",
    );
    store.close();
  });

  it("keeps its own copy of a vector that is a view into a larger buffer", async () => {
    const store = new SqliteVectorStore(2);
    const big = Float32Array.from([9, 9, 1, 0, 9, 9]);
    await store.upsert([{ id: "view" as ChunkId, vector: big.subarray(2, 4), metadata: meta }]);
    const hits = await store.search(Float32Array.from([1, 0]), 1);
    expect(hits[0]?.score).toBeCloseTo(1, 6);
    store.close();
  });
});

describe("SqliteVectorStore: filters", () => {
  it("treats an empty `in` list as matching nothing and quotes values safely", async () => {
    const store = new SqliteVectorStore(2);
    await store.upsert([record("a", 1, 0)]);
    const q = Float32Array.from([1, 0]);
    expect(await store.search(q, 5, [{ kind: "in", field: "docId", values: [] }])).toEqual([]);
    const hostile = "x'; DROP TABLE records; --";
    expect(await store.search(q, 5, [{ kind: "equals", field: "docId", value: hostile }])).toEqual(
      [],
    );
    expect(await store.count()).toBe(1);
    store.close();
  });

  it("accepts an open-ended page range", async () => {
    const store = new SqliteVectorStore(2);
    await store.upsert([
      { ...record("early", 1, 0), metadata: { ...meta, pageStart: 1, pageEnd: 2 } },
      { ...record("late", 1, 0), metadata: { ...meta, pageStart: 8, pageEnd: 9 } },
    ]);
    const q = Float32Array.from([1, 0]);
    const ids = async (from?: number, to?: number): Promise<string[]> =>
      (
        await store.search(q, 5, [
          {
            kind: "pageRange",
            ...(from === undefined ? {} : { from }),
            ...(to === undefined ? {} : { to }),
          },
        ])
      ).map((h) => h.id);
    expect(await ids(2)).toEqual(["early", "late"]);
    expect(await ids(3)).toEqual(["late"]);
    expect(await ids(undefined, 7)).toEqual(["early"]);
    expect(await ids()).toEqual(["early", "late"]);
    store.close();
  });
});

describe("SqliteVectorStore: a file on disk", () => {
  it("keeps its records after being closed and opened again", async () => {
    const file = await tempFile();
    const first = new SqliteVectorStore(2, file);
    await first.upsert([record("a", 1, 0), record("b", 0, 1)]);
    first.close();

    const second = new SqliteVectorStore(2, file);
    expect(await second.count()).toBe(2);
    expect((await second.search(Float32Array.from([0, 1]), 1))[0]?.id).toBe("b");
    second.close();
  });

  it("refuses a file written with another number of dimensions", async () => {
    const file = await tempFile();
    new SqliteVectorStore(2, file).close();
    expect(() => new SqliteVectorStore(3, file)).toThrow(/2-dimension/);
  });
});

describe("SqliteVectorStore: section filters", () => {
  const inSection = (id: string, sectionPath: string[], ...values: number[]): VectorRecord => ({
    ...record(id, ...values),
    metadata: { ...meta, sectionPath },
  });

  it("matches a chapter and a section by path prefix, ignoring case and spaces", async () => {
    const store = new SqliteVectorStore(2);
    await store.upsert([
      inSection("a", ["Chapter 3", "3.1 Intro"], 1, 0),
      inSection("b", [" CHAPTER 3 ", "3.2 Embeddings"], 0.9, 0.1),
      inSection("c", ["Chapter 33"], 0.8, 0.2),
      inSection("d", [], 0.7, 0.3),
    ]);
    const ids = async (path: string[]) =>
      (await store.search(Float32Array.from([1, 0]), 10, [{ kind: "section", path }]))
        .map((hit) => hit.id)
        .sort();
    expect(await ids(["chapter 3"])).toEqual(["a", "b"]);
    expect(await ids(["Chapter 3", "3.2 embeddings"])).toEqual(["b"]);
    expect(await ids(["Chapter 4"])).toEqual([]);
    store.close();
  });

  it("rejects an empty or blank section path as INVALID_ARGUMENT", async () => {
    const store = new SqliteVectorStore(2);
    for (const path of [[], ["Chapter 1", "  "]]) {
      expect(
        await codeOf(store.search(Float32Array.from([1, 0]), 1, [{ kind: "section", path }])),
      ).toBe("INVALID_ARGUMENT");
    }
    store.close();
  });

  it("opens a file made before section filters existed, keeping its records", async () => {
    const file = await tempFile();
    await mkdir(path.dirname(file), { recursive: true });
    // the table as RAG-045 created it, without the section_path column
    const old = new DatabaseSync(file);
    old.exec(`
      CREATE TABLE store_info (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO store_info VALUES ('dimensions', '2');
      CREATE TABLE records (
        id TEXT PRIMARY KEY, vector BLOB NOT NULL, doc_id TEXT NOT NULL, strategy TEXT NOT NULL,
        page_start INTEGER NOT NULL, page_end INTEGER NOT NULL
      );
    `);
    old
      .prepare("INSERT INTO records VALUES (?, ?, ?, ?, ?, ?)")
      .run("old", new Uint8Array(Float32Array.from([1, 0]).buffer), "doc", "recursive", 1, 1);
    old.close();

    const store = new SqliteVectorStore(2, file);
    await store.upsert([inSection("new", ["Chapter 1"], 0.5, 0.5)]);
    expect(await store.count()).toBe(2);
    const section = [{ kind: "section", path: ["Chapter 1"] }] as const;
    // the old row has no section, the new one does
    expect((await store.search(Float32Array.from([1, 0]), 5, section)).map((h) => h.id)).toEqual([
      "new",
    ]);
    expect((await store.search(Float32Array.from([1, 0]), 5)).map((h) => h.id)).toContain("old");
    store.close();
  });
});

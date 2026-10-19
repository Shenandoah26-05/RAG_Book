import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  ChunkId,
  ChunkMetadata,
  DocId,
  ExportableVectorStore,
  VectorRecord,
} from "../../core/index.js";
import { createJsonLogger, RagError } from "../../shared/index.js";
import { INDEX_FORMAT_VERSION, IndexFile } from "./index-file.js";

/** The least a store needs: keeps what it is given. Search is not what is being tested here. */
class FakeStore implements ExportableVectorStore {
  readonly #records = new Map<ChunkId, VectorRecord>();
  constructor(readonly dimensions: number) {}
  upsert(records: readonly VectorRecord[]): Promise<void> {
    for (const record of records) {
      if (record.vector.length !== this.dimensions) {
        return Promise.reject(new RagError("INVALID_ARGUMENT", "wrong length"));
      }
    }
    // copy, like a real store: the vectors handed in are views into one big buffer
    for (const record of records) {
      this.#records.set(record.id, { ...record, vector: Float32Array.from(record.vector) });
    }
    return Promise.resolve();
  }
  search(): Promise<never> {
    return Promise.reject(new Error("not needed"));
  }
  delete(): Promise<void> {
    return Promise.resolve();
  }
  count(): Promise<number> {
    return Promise.resolve(this.#records.size);
  }
  records(): Iterable<VectorRecord> {
    return this.#records.values();
  }
}

const meta = (overrides: Partial<ChunkMetadata> = {}): ChunkMetadata => ({
  docId: "doc-1" as DocId,
  pageStart: 3,
  pageEnd: 4,
  sectionPath: ["Chapter 1", "1.2 Embeddings"],
  charStart: 10,
  charEnd: 99,
  strategy: "recursive",
  ...overrides,
});
const record = (id: string, vector: number[], metadata = meta()): VectorRecord => ({
  id: id as ChunkId,
  vector: Float32Array.from(vector),
  metadata,
});

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return error instanceof RagError ? error.code : "not a RagError";
  }
  return undefined;
}

let root: string;
let dir: string;
let file: IndexFile;

async function savedStore(): Promise<FakeStore> {
  const store = new FakeStore(3);
  await store.upsert([
    record("a", [0.1, -0.25, 3]),
    record("b", [1e-8, 2, 0], meta({ pageStart: 9, pageEnd: 9, sectionPath: [] })),
    record("c", [-1, -1, -1], meta({ docId: "doc-2" as DocId })),
  ]);
  await file.save(store);
  return store;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "rag-index-"));
  dir = path.join(root, "index");
  file = new IndexFile(dir);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("IndexFile: save and load", () => {
  it("brings back every vector bit for bit, with its id and metadata, in order", async () => {
    const original = await savedStore();
    const loaded = new FakeStore(3);
    const result = await file.load(loaded);

    expect(result).toMatchObject({ count: 3, dimensions: 3 });
    expect([...loaded.records()]).toEqual([...original.records()]);
  });

  it("writes vectors as raw floats: 4 bytes each, no header", async () => {
    await savedStore();
    const bytes = await readFile(path.join(dir, "vectors.f32"));
    expect(bytes.length).toBe(3 * 3 * 4);
    expect(bytes.readFloatLE(0)).toBeCloseTo(0.1, 6);
    expect(bytes.readFloatLE(8)).toBe(3);
  });

  it("describes the index in index.json", async () => {
    await savedStore();
    const json = JSON.parse(await readFile(path.join(dir, "index.json"), "utf8")) as {
      formatVersion: number;
      dimensions: number;
      count: number;
      entries: { id: string }[];
    };
    expect(json).toMatchObject({ formatVersion: INDEX_FORMAT_VERSION, dimensions: 3, count: 3 });
    expect(json.entries.map((entry) => entry.id)).toEqual(["a", "b", "c"]);
  });

  it("saves and loads an empty store", async () => {
    await file.save(new FakeStore(3));
    const loaded = new FakeStore(3);
    expect(await file.load(loaded)).toMatchObject({ count: 0, dimensions: 3 });
    expect(await loaded.count()).toBe(0);
  });

  it("replaces an earlier index", async () => {
    await savedStore();
    const smaller = new FakeStore(3);
    await smaller.upsert([record("only", [1, 2, 3])]);
    await file.save(smaller);

    const loaded = new FakeStore(3);
    await file.load(loaded);
    expect([...loaded.records()].map((r) => r.id)).toEqual(["only"]);
  });

  it("leaves no temporary files behind", async () => {
    await savedStore();
    expect((await readdir(dir)).sort()).toEqual(["index.json", "vectors.f32"]);
  });

  it("says whether an index exists", async () => {
    expect(await file.exists()).toBe(false);
    await savedStore();
    expect(await file.exists()).toBe(true);
  });

  it("logs how many vectors it loaded and how long it took", async () => {
    await savedStore();
    const lines: string[] = [];
    const logged = new IndexFile(dir, createJsonLogger({ write: (line) => lines.push(line) }));
    await logged.load(new FakeStore(3));

    const entry = JSON.parse(lines.at(-1) ?? "{}") as Record<string, unknown>;
    expect(entry).toMatchObject({ message: "index loaded", count: 3, dimensions: 3 });
    expect(entry.durationMs).toEqual(expect.any(Number));
  });
});

describe("IndexFile: errors", () => {
  it("says so, with INVALID_ARGUMENT, when there is no index yet", async () => {
    const promise = file.load(new FakeStore(3));
    expect(await codeOf(promise)).toBe("INVALID_ARGUMENT");
    await expect(file.load(new FakeStore(3))).rejects.toThrow(/no saved index/);
  });

  it("refuses an index of other dimensions, and tells the reader why", async () => {
    await savedStore();
    const wrong = new FakeStore(4);
    const promise = file.load(wrong);
    expect(await codeOf(promise)).toBe("INVALID_ARGUMENT");
    await expect(file.load(wrong)).rejects.toThrow(/3-dimensional.*takes 4.*embedding model/);
    expect(await wrong.count()).toBe(0);
  });

  it("detects a vectors file that was cut short", async () => {
    await savedStore();
    const vectors = path.join(dir, "vectors.f32");
    await writeFile(vectors, (await readFile(vectors)).subarray(0, 20));

    const loaded = new FakeStore(3);
    expect(await codeOf(file.load(loaded))).toBe("INDEX_CORRUPT");
    await expect(file.load(loaded)).rejects.toThrow(/20 bytes.*need 36/);
    expect(await loaded.count()).toBe(0);
  });

  it("detects a vectors file where a byte was changed", async () => {
    await savedStore();
    const vectors = path.join(dir, "vectors.f32");
    const bytes = await readFile(vectors);
    bytes[5] = (bytes[5] ?? 0) ^ 0xff;
    await writeFile(vectors, bytes);

    const loaded = new FakeStore(3);
    expect(await codeOf(file.load(loaded))).toBe("INDEX_CORRUPT");
    await expect(file.load(loaded)).rejects.toThrow(/checksum/);
    expect(await loaded.count()).toBe(0);
  });

  it("detects a missing vectors file", async () => {
    await savedStore();
    await rm(path.join(dir, "vectors.f32"));
    expect(await codeOf(file.load(new FakeStore(3)))).toBe("INDEX_CORRUPT");
  });

  it("detects an index.json that is not JSON", async () => {
    await savedStore();
    await writeFile(path.join(dir, "index.json"), "{ not json");
    expect(await codeOf(file.load(new FakeStore(3)))).toBe("INDEX_CORRUPT");
  });

  it("detects an index.json of the wrong shape", async () => {
    await savedStore();
    await writeFile(
      path.join(dir, "index.json"),
      JSON.stringify({ formatVersion: INDEX_FORMAT_VERSION, dimensions: 3 }),
    );
    expect(await codeOf(file.load(new FakeStore(3)))).toBe("INDEX_CORRUPT");
  });

  it("refuses a format version it does not know", async () => {
    await savedStore();
    const metaFile = path.join(dir, "index.json");
    const json = JSON.parse(await readFile(metaFile, "utf8")) as Record<string, unknown>;
    await writeFile(metaFile, JSON.stringify({ ...json, formatVersion: 99, something: "new" }));

    const loaded = new FakeStore(3);
    expect(await codeOf(file.load(loaded))).toBe("INDEX_CORRUPT");
    await expect(file.load(loaded)).rejects.toThrow(/version 99/);
  });

  it("detects a count that disagrees with the entries", async () => {
    await savedStore();
    const metaFile = path.join(dir, "index.json");
    const json = JSON.parse(await readFile(metaFile, "utf8")) as { entries: unknown[] };
    json.entries.pop();
    await writeFile(metaFile, JSON.stringify(json));
    expect(await codeOf(file.load(new FakeStore(3)))).toBe("INDEX_CORRUPT");
  });

  it("detects the same id listed twice", async () => {
    await savedStore();
    const metaFile = path.join(dir, "index.json");
    const json = JSON.parse(await readFile(metaFile, "utf8")) as {
      entries: { id: string }[];
    };
    json.entries[1] = { ...json.entries[1], id: "a" };
    await writeFile(metaFile, JSON.stringify(json));
    expect(await codeOf(file.load(new FakeStore(3)))).toBe("INDEX_CORRUPT");
  });
});

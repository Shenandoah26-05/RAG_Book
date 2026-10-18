import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { SqliteVectorStore } from "../adapters/index.js";
import { DEFAULT_CONFIG } from "../config/index.js";
import { RagError } from "../shared/index.js";
import { FlatVectorStore } from "../strategies/index.js";
import { buildVectorStore, SQLITE_INDEX_FILE, vectorStoreNames } from "./build-vector-store.js";

const folders: string[] = [];
afterAll(async () => {
  await Promise.all(folders.map((f) => rm(f, { recursive: true, force: true })));
});

describe("buildVectorStore", () => {
  it("knows the two stores by their config names", () => {
    expect(vectorStoreNames()).toEqual(["in-memory", "sqlite"]);
  });

  it("builds the flat store for the default configuration", () => {
    const store = buildVectorStore(DEFAULT_CONFIG.vectorStore, 384);
    expect(store).toBeInstanceOf(FlatVectorStore);
    expect(store.dimensions).toBe(384);
  });

  it("builds the SQLite store inside vectorStore.dir", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "rag-build-store-"));
    folders.push(dir);
    const store = buildVectorStore({ type: "sqlite", dir }, 8);
    expect(store).toBeInstanceOf(SqliteVectorStore);
    expect(store.dimensions).toBe(8);
    (store as SqliteVectorStore).close();
    // the file exists, so a second store built from the same config sees the same index
    const again = buildVectorStore({ type: "sqlite", dir }, 8) as SqliteVectorStore;
    expect(await again.count()).toBe(0);
    again.close();
    expect(SQLITE_INDEX_FILE).toBe("vectors.sqlite");
  });

  it("throws CONFIG_INVALID naming the stores that exist for an unknown type", () => {
    expect(() => buildVectorStore({ type: "pinecone", dir: "x" }, 4)).toThrow(RagError);
    expect(() => buildVectorStore({ type: "pinecone", dir: "x" }, 4)).toThrow(
      /Known stores: in-memory, sqlite/,
    );
  });
});

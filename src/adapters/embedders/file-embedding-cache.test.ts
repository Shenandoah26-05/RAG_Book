import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { embeddingCacheKey } from "./caching-embedder.js";
import { FileEmbeddingCache } from "./file-embedding-cache.js";

let root: string;
let cache: FileEmbeddingCache;
const key = embeddingCacheKey("m", "document", "hello");

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "rag-embcache-"));
  cache = new FileEmbeddingCache(path.join(root, "embeddings"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("FileEmbeddingCache", () => {
  it("gives back the exact vector it was given", async () => {
    const vector = Float32Array.from([0.1, -0.25, 3, 1e-8]);
    await cache.set(key, vector);
    expect(await cache.get(key)).toEqual(vector);
  });

  it("gives undefined for a key it has not seen, even before the folder exists", async () => {
    expect(await cache.get(key)).toBeUndefined();
  });

  it("stores raw floats in a sub-folder named after the first two characters", async () => {
    await cache.set(key, Float32Array.from([1, 2]));
    const file = path.join(root, "embeddings", key.slice(0, 2), `${key}.bin`);
    expect(cache.locationOf(key)).toBe(file);
    expect((await readFile(file)).length).toBe(8);
  });

  it("works with a vector that is a view into a bigger buffer", async () => {
    const view = new Float32Array(new Float32Array([9, 1, 2, 3]).buffer, 4, 3);
    await cache.set(key, view);
    expect([...((await cache.get(key)) ?? [])]).toEqual([1, 2, 3]);
  });

  it("overwrites an existing entry and leaves no temporary files", async () => {
    await cache.set(key, Float32Array.from([1]));
    await cache.set(key, Float32Array.from([2]));
    expect([...((await cache.get(key)) ?? [])]).toEqual([2]);
    const names = await readdir(path.dirname(cache.locationOf(key)));
    expect(names.filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("treats a damaged file as missing", async () => {
    await mkdir(path.dirname(cache.locationOf(key)), { recursive: true });
    await writeFile(cache.locationOf(key), Buffer.from([1, 2, 3]));
    expect(await cache.get(key)).toBeUndefined();
    await writeFile(cache.locationOf(key), Buffer.alloc(0));
    expect(await cache.get(key)).toBeUndefined();
  });

  it("refuses a key that is not a hash, so it can never leave its folder", async () => {
    await expect(cache.get("../../secrets")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(cache.set("../x", new Float32Array(1))).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  });
});

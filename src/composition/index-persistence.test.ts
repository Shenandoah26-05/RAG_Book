import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IndexFile } from "../adapters/index.js";
import type { ChunkId, ChunkMetadata, DocId, VectorRecord } from "../core/index.js";
import { FlatVectorStore } from "../strategies/index.js";

const DIMENSIONS = 16;
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "rag-persist-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Deterministic pseudo-random numbers, so a failure can be reproduced. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296 - 0.5;
  };
}

function records(count: number, next: () => number): VectorRecord[] {
  return Array.from({ length: count }, (_, i) => {
    const metadata: ChunkMetadata = {
      docId: `doc-${(i % 3).toString()}` as DocId,
      pageStart: i + 1,
      pageEnd: i + 2,
      sectionPath: [`Chapter ${(i % 5).toString()}`],
      charStart: i * 10,
      charEnd: i * 10 + 9,
      strategy: "recursive",
    };
    return {
      id: `chunk-${i.toString().padStart(4, "0")}` as ChunkId,
      vector: Float32Array.from({ length: DIMENSIONS }, next),
      metadata,
    };
  });
}

describe("IndexFile with FlatVectorStore", () => {
  it("answers every search exactly as the store that was saved did", async () => {
    const next = random(42);
    const original = new FlatVectorStore(DIMENSIONS);
    await original.upsert(records(300, next));
    const file = new IndexFile(dir);
    await file.save(original);

    const restored = new FlatVectorStore(DIMENSIONS);
    await file.load(restored);

    expect(await restored.count()).toBe(300);
    for (let query = 0; query < 20; query++) {
      const vector = Float32Array.from({ length: DIMENSIONS }, next);
      expect(await restored.search(vector, 7)).toEqual(await original.search(vector, 7));
    }
    // metadata survives too: a filter still finds the same records
    const vector = Float32Array.from({ length: DIMENSIONS }, next);
    const filter = [{ kind: "equals", field: "docId", value: "doc-1" }] as const;
    const filtered = await restored.search(vector, 5, filter);
    expect(filtered).toEqual(await original.search(vector, 5, filter));
    expect(filtered.length).toBeGreaterThan(0);
  });
});

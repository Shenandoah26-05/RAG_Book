import { describe, expect, it } from "vitest";
import type { Chunk, ChunkId, DocId, RetrievedChunk, Retriever } from "../../core/index.js";
import { Trace } from "../../shared/index.js";
import { ObservedRetriever } from "./observed-retriever.js";

const chunk: Chunk = {
  id: "c1" as ChunkId,
  text: "hello",
  metadata: {
    docId: "d" as DocId,
    pageStart: 1,
    pageEnd: 1,
    sectionPath: [],
    charStart: 0,
    charEnd: 5,
    strategy: "recursive",
  },
};
const found: RetrievedChunk[] = [{ chunk, score: 0.5, rank: 1, retriever: "dense" }];

const inner: Retriever = { name: "dense", retrieve: () => Promise.resolve(found) };

describe("ObservedRetriever", () => {
  it("returns exactly what the wrapped retriever returned, under the same name", async () => {
    const seen: [string, readonly RetrievedChunk[]][] = [];
    const observed = new ObservedRetriever(inner, new Trace(), (n, r) => seen.push([n, r]));
    expect(observed.name).toBe("dense");
    expect(await observed.retrieve({ text: "q" }, { k: 3 })).toBe(found);
    expect(seen).toEqual([["dense", found]]);
  });

  it("passes the query and options on unchanged", async () => {
    const calls: unknown[] = [];
    const spy: Retriever = {
      name: "spy",
      retrieve: (query, options) => {
        calls.push([query, options]);
        return Promise.resolve([]);
      },
    };
    const filter = [{ kind: "pageRange", from: 2 }] as const;
    await new ObservedRetriever(spy, new Trace(), () => undefined).retrieve(
      { text: "q" },
      { k: 4, filter },
    );
    expect(calls).toEqual([[{ text: "q" }, { k: 4, filter }]]);
  });

  it("records a stage in the trace with its time and how many chunks it found", async () => {
    let now = 0;
    const trace = new Trace(() => now);
    const slow: Retriever = {
      name: "dense",
      retrieve: () => {
        now += 25;
        return Promise.resolve(found);
      },
    };
    now = 10;
    await new ObservedRetriever(slow, trace, () => undefined).retrieve({ text: "q" }, { k: 1 });
    expect(trace.stages).toEqual([
      { stage: "dense", startMs: 10, durationMs: 25, status: "ok", summary: { chunks: 1 } },
    ]);
  });

  it("records an error stage and rethrows the error, reporting no results", async () => {
    const trace = new Trace();
    const seen: string[] = [];
    const broken: Retriever = { name: "bm25", retrieve: () => Promise.reject(new Error("boom")) };
    const observed = new ObservedRetriever(broken, trace, (n) => seen.push(n));
    await expect(observed.retrieve({ text: "q" }, { k: 1 })).rejects.toThrow("boom");
    expect(trace.stages[0]).toMatchObject({ stage: "bm25", status: "error", error: "boom" });
    expect(seen).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import type { Chunk, ChunkId, DocId, RetrievedChunk, Retriever } from "../../core/index.js";
import { RetrievalProbe, withProbe } from "../../shared/index.js";
import { ProbedRetriever } from "./probed-retriever.js";

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

describe("ProbedRetriever", () => {
  it("returns exactly what the wrapped retriever returned, under the same name", async () => {
    const probed = new ProbedRetriever(inner);
    expect(probed.name).toBe("dense");
    expect(await probed.retrieve({ text: "q" }, { k: 3 })).toBe(found);
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
    await new ProbedRetriever(spy).retrieve({ text: "q" }, { k: 3 });
    expect(calls).toEqual([[{ text: "q" }, { k: 3 }]]);
  });

  it("reports what it found to the probe of the question in scope", async () => {
    const probe = new RetrievalProbe();
    await withProbe(probe, () => new ProbedRetriever(inner).retrieve({ text: "q" }, { k: 3 }));
    expect(probe.calls).toEqual([{ name: "dense", results: found }]);
  });

  it("serves several questions with the one instance, each to its own probe", async () => {
    const probed = new ProbedRetriever(inner);
    const [a, b] = [new RetrievalProbe(), new RetrievalProbe()];
    await Promise.all([
      withProbe(a, () => probed.retrieve({ text: "1" }, { k: 1 })),
      withProbe(b, () => probed.retrieve({ text: "2" }, { k: 1 })),
    ]);
    expect(a.calls).toHaveLength(1);
    expect(b.calls).toHaveLength(1);
  });

  it("works outside a question, with nobody to report to", async () => {
    expect(await new ProbedRetriever(inner).retrieve({ text: "q" }, { k: 3 })).toBe(found);
  });

  it("records nothing for a failed search, and rethrows its error", async () => {
    const boom = new Error("index gone");
    const failing: Retriever = { name: "dense", retrieve: () => Promise.reject(boom) };
    const probe = new RetrievalProbe();
    await expect(
      withProbe(probe, () => new ProbedRetriever(failing).retrieve({ text: "q" }, { k: 1 })),
    ).rejects.toBe(boom);
    expect(probe.calls).toEqual([]);
  });
});

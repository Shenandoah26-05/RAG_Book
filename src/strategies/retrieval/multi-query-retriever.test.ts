import { describe, expect, it } from "vitest";
import { makeChunkId } from "../../core/index.js";
import type { Chunk, RetrieveOptions, RetrievedChunk, Retriever } from "../../core/index.js";
import { makeDocId } from "../../shared/index.js";
import { MultiQueryRetriever } from "./multi-query-retriever.js";
import { RrfFusion } from "./rrf-fusion.js";

const DOC = makeDocId("a".repeat(64));

function chunk(text: string): Chunk {
  return {
    id: makeChunkId({
      docId: DOC,
      strategy: "recursive",
      charStart: 0,
      charEnd: text.length,
      text,
    }),
    text,
    metadata: {
      docId: DOC,
      pageStart: 1,
      pageEnd: 1,
      sectionPath: [],
      charStart: 0,
      charEnd: text.length,
      strategy: "recursive",
    },
  };
}

const A = chunk("alpha");
const B = chunk("bravo");
const C = chunk("charlie");
const D = chunk("delta");

/** A retriever that returns a fixed ranking per question text, and records how it was asked. */
function scripted(rankings: Record<string, Chunk[]>) {
  const asked: { text: string; options: RetrieveOptions }[] = [];
  const retriever: Retriever = {
    name: "dense",
    retrieve: (query, options) => {
      asked.push({ text: query.text, options });
      const found: RetrievedChunk[] = (rankings[query.text] ?? [])
        .slice(0, options.k)
        .map((c, i) => ({ chunk: c, score: 1 - i * 0.1, rank: i + 1, retriever: "dense" }));
      return Promise.resolve(found);
    },
  };
  return { retriever, asked };
}

const wrap = (inner: Retriever, depth?: number) =>
  new MultiQueryRetriever({
    inner,
    fusion: new RrfFusion(),
    ...(depth === undefined ? {} : { depth }),
  });

describe("MultiQueryRetriever", () => {
  it("names itself after what it wraps", () => {
    expect(wrap(scripted({}).retriever).name).toBe("multi-query(dense)");
  });

  it("searches once and returns the inner result when there are no variants", async () => {
    const { retriever, asked } = scripted({ q: [A, B] });
    const found = await wrap(retriever).retrieve(
      { text: "q", history: [{ question: "x", answer: "y" }] },
      { k: 2 },
    );
    expect(asked).toHaveLength(1);
    expect(asked[0]).toEqual({ text: "q", options: { k: 2 } });
    expect(found.map((r) => [r.chunk.id, r.rank, r.retriever])).toEqual([
      [A.id, 1, "multi-query(dense)"],
      [B.id, 2, "multi-query(dense)"],
    ]);
  });

  it("searches for the question and each variant, and fuses the rankings", async () => {
    const { retriever, asked } = scripted({ q: [A, B], v1: [C, B], v2: [D, B] });
    const found = await wrap(retriever).retrieve({ text: "q", variants: ["v1", "v2"] }, { k: 3 });
    expect(asked.map((a) => a.text).sort()).toEqual(["q", "v1", "v2"]);
    // B is second in all three lists, so it beats the three chunks that are first in only one
    expect(found.map((r) => r.chunk.id)[0]).toBe(B.id);
    expect(found.map((r) => r.rank)).toEqual([1, 2, 3]);
    expect(new Set(found.map((r) => r.chunk.id)).size).toBe(3);
    expect(found.every((r) => r.retriever === "multi-query(dense)")).toBe(true);
    for (let i = 1; i < found.length; i++) {
      expect((found[i] as RetrievedChunk).score).toBeLessThanOrEqual(
        (found[i - 1] as RetrievedChunk).score,
      );
    }
  });

  it("asks each search for max(k, depth) chunks and passes the filter", async () => {
    const { retriever, asked } = scripted({ q: [A], v: [B] });
    const filter = { chapter: 2 } as unknown as RetrieveOptions["filter"];
    await wrap(retriever, 7).retrieve({ text: "q", variants: ["v"] }, { k: 2, filter });
    expect(asked.map((a) => a.options)).toEqual([
      { k: 7, filter },
      { k: 7, filter },
    ]);
    asked.length = 0;
    await wrap(retriever, 7).retrieve({ text: "q", variants: ["v"] }, { k: 9 });
    expect(asked.every((a) => a.options.k === 9)).toBe(true);
  });

  it("ignores variants that are blank or copies", async () => {
    const { retriever, asked } = scripted({ q: [A] });
    await wrap(retriever).retrieve({ text: "Q", variants: ["q", "  ", "Q "] }, { k: 1 });
    expect(asked).toHaveLength(1);
  });

  it("passes only the text down to the inner retriever", async () => {
    const seen: unknown[] = [];
    const inner: Retriever = {
      name: "dense",
      retrieve: (query) => {
        seen.push(query);
        return Promise.resolve([]);
      },
    };
    await wrap(inner).retrieve(
      { text: "q", variants: ["v"], history: [{ question: "a", answer: "b" }] },
      { k: 1 },
    );
    expect(seen).toEqual([{ text: "q" }, { text: "v" }]);
  });

  it("gives an empty list when nothing matches", async () => {
    expect(
      await wrap(scripted({}).retriever).retrieve({ text: "q", variants: ["v"] }, { k: 3 }),
    ).toEqual([]);
  });

  it("fails when one search fails", async () => {
    const inner: Retriever = {
      name: "dense",
      retrieve: (query) =>
        query.text === "v" ? Promise.reject(new Error("boom")) : Promise.resolve([]),
    };
    await expect(wrap(inner).retrieve({ text: "q", variants: ["v"] }, { k: 1 })).rejects.toThrow(
      "boom",
    );
  });

  it("rejects a bad k and a blank question before searching", async () => {
    const { retriever, asked } = scripted({});
    const multi = wrap(retriever);
    await expect(multi.retrieve({ text: "q" }, { k: 0 })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    await expect(multi.retrieve({ text: " " }, { k: 1 })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    expect(asked).toHaveLength(0);
  });

  it("rejects a bad depth", () => {
    for (const depth of [0, 1.5, -1]) {
      expect(() => wrap(scripted({}).retriever, depth)).toThrow(/depth/);
    }
  });
});

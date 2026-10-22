import { describe, expect, it } from "vitest";
import { Trace } from "../shared/index.js";
import type { PriceTable } from "../shared/index.js";
import { CHUNK, DOC, chunkOf } from "./api.testing.js";
import { toMetadataFilter, toWireChunk, toWireCitation, toWireTrace } from "./mappers.js";

describe("toMetadataFilter", () => {
  it("is nothing for no filter, and for a filter with no part", () => {
    expect(toMetadataFilter(undefined)).toBeUndefined();
    expect(toMetadataFilter({})).toBeUndefined();
  });

  it("writes one value as `equals` and several as `in`", () => {
    expect(toMetadataFilter({ documents: [DOC] })).toEqual([
      { kind: "equals", field: "docId", value: DOC },
    ]);
    expect(toMetadataFilter({ strategies: ["a", "b"] })).toEqual([
      { kind: "in", field: "strategy", values: ["a", "b"] },
    ]);
  });

  it("writes a section as a path and pages as a range with open ends", () => {
    expect(toMetadataFilter({ section: ["Chapter 3"] })).toEqual([
      { kind: "section", path: ["Chapter 3"] },
    ]);
    expect(toMetadataFilter({ pages: { from: 5 } })).toEqual([{ kind: "pageRange", from: 5 }]);
    expect(toMetadataFilter({ pages: { to: 9 } })).toEqual([{ kind: "pageRange", to: 9 }]);
  });
});

describe("toWireChunk", () => {
  it("copies the fields by name and leaves out an absent parent", () => {
    const wire = toWireChunk(CHUNK);
    expect(wire).toEqual({
      id: CHUNK.id,
      docId: DOC,
      text: CHUNK.text,
      pageStart: 1,
      pageEnd: 2,
      sectionPath: ["Chapter 1", "1.1 Vectors"],
      charStart: CHUNK.metadata.charStart,
      charEnd: CHUNK.metadata.charEnd,
      strategy: "recursive",
    });
    expect(wire).not.toHaveProperty("parentId");
  });

  it("does not leak a field the contract does not name", () => {
    const withExtra = { ...CHUNK, embedText: "heading > text", secret: 1 } as typeof CHUNK;
    expect(Object.keys(toWireChunk(withExtra)).sort()).toEqual(
      [
        "charEnd",
        "charStart",
        "docId",
        "id",
        "pageEnd",
        "pageStart",
        "sectionPath",
        "strategy",
        "text",
      ].sort(),
    );
  });

  it("does not share the section path with the library's object", () => {
    const wire = toWireChunk(chunkOf("Embeddings map text to vectors."));
    expect(wire.sectionPath).not.toBe(CHUNK.metadata.sectionPath);
  });
});

describe("toWireCitation", () => {
  it("copies the fields by name", () => {
    const wire = toWireCitation({
      index: 2,
      chunkId: CHUNK.id,
      docId: DOC,
      pageStart: 1,
      pageEnd: 2,
      charStart: 3,
      charEnd: 9,
      quote: "q",
      extra: "ignored",
    } as Parameters<typeof toWireCitation>[0]);
    expect(Object.keys(wire).sort()).toEqual(
      ["charEnd", "charStart", "chunkId", "docId", "index", "pageEnd", "pageStart", "quote"].sort(),
    );
  });
});

describe("toWireTrace", () => {
  const prices: PriceTable = { currency: "USD", models: {} };

  function traceOf() {
    const trace = new Trace();
    trace.start("retrieve").end({ found: 5, retriever: "hybrid" });
    trace.start("rerank").fail(new Error("model down"));
    return trace.snapshot();
  }

  it("keeps each stage's timing, status, summary and error", () => {
    const wire = toWireTrace(traceOf(), prices);
    expect(wire.stages.map((s) => [s.stage, s.status])).toEqual([
      ["retrieve", "ok"],
      ["rerank", "error"],
    ]);
    expect(wire.stages[0]?.summary).toEqual({ found: 5, retriever: "hybrid" });
    expect(wire.stages[1]?.error).toBe("model down");
    expect(wire.stages[0]).not.toHaveProperty("error");
  });

  it("has no usage when no model or embedder was called", () => {
    expect(toWireTrace(traceOf(), prices)).not.toHaveProperty("usage");
  });

  it("copies the summaries, so a change to the trace does not reach the wire object", () => {
    const snapshot = traceOf();
    const wire = toWireTrace(snapshot, prices);
    expect(wire.stages[0]?.summary).not.toBe(snapshot.stages[0]?.summary);
  });
});

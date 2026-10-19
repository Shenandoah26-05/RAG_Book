import { describe, expect, it } from "vitest";
import type {
  Chunker,
  DocId,
  DocumentStore,
  EmbedKind,
  Embedder,
  IndexContents,
  IndexManifest,
  IndexWriter,
  ParsedDocument,
} from "../core/index.js";
import { makeDocId, noopLogger, RagError } from "../shared/index.js";
import { FlatVectorStore, InMemoryChunkStore, RecursiveChunker } from "../strategies/index.js";
import { createChunk } from "../strategies/index.js";
import { makeDocument } from "../testing/make-document.testing.js";
import { buildIndex } from "./build-index.js";
import type { IndexSettings } from "./build-index.js";

const DIMENSIONS = 4;

const docA = makeDocument([
  "Vectors are lists of numbers. They can be compared.\n\nCosine similarity measures the angle between two vectors.",
  "Chunks are passages of a document. Each chunk gets one vector.",
]);
const docB: ParsedDocument = {
  ...makeDocument(["A second book about retrieval. It has its own text for chunking."]),
  id: makeDocId("b".repeat(64)),
};

/** Same text, same vector; a made-up but repeatable unit vector. */
function vectorFor(text: string): Float32Array {
  const v = Float32Array.from(
    { length: DIMENSIONS },
    (_, i) => ((text.charCodeAt(i) || 1) % 9) + 1,
  );
  const length = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / length);
}

interface EmbedCall {
  readonly texts: readonly string[];
  readonly kind: EmbedKind;
}

function fakeEmbedder(): Embedder & { calls: EmbedCall[] } {
  const calls: EmbedCall[] = [];
  return {
    modelId: "fake:model",
    dimensions: DIMENSIONS,
    calls,
    embed: (texts, kind) => {
      calls.push({ texts: [...texts], kind });
      return Promise.resolve(texts.map(vectorFor));
    },
  };
}

function fakeDocuments(...docs: ParsedDocument[]): DocumentStore {
  const byId = new Map(docs.map((d) => [d.id, d]));
  return {
    has: (id) => Promise.resolve(byId.has(id)),
    list: () => Promise.resolve([...byId.keys()].sort()),
    load: (id) => Promise.resolve(byId.get(id)),
    save: () => Promise.reject(new Error("not used")),
    locationOf: (id) => `/docs/${id}.json`,
  };
}

/** Keeps the last index it was given, like a disk would. */
function memoryWriter(): IndexWriter & { writes: IndexContents[] } {
  const writes: IndexContents[] = [];
  const kept = new Map<string, IndexManifest>();
  return {
    writes,
    readManifest: (namespace) => Promise.resolve(kept.get(namespace)),
    write: (contents) => {
      writes.push(contents);
      kept.set(contents.manifest.namespace, contents.manifest);
      return Promise.resolve(`/index/${contents.manifest.namespace}`);
    },
    locationOf: (namespace) => `/index/${namespace}`,
  };
}

const recursive = (): Chunker =>
  new RecursiveChunker({ maxTokens: 40, overlapTokens: 5, count: (t) => t.length });

const settings = (overrides: Partial<IndexSettings> = {}): IndexSettings => ({
  namespace: "recursive__fake-model",
  chunker: { name: "recursive", tokenizer: "approx", maxTokens: 40, overlapTokens: 5 },
  batchSize: 3,
  configHash: "c".repeat(64),
  gitCommit: "abc1234",
  ...overrides,
});

function setup(options: { chunker?: Chunker; docs?: ParsedDocument[] } = {}) {
  const docs = options.docs ?? [docA, docB];
  const embedder = fakeEmbedder();
  const writer = memoryWriter();
  const vectorStore = new FlatVectorStore(DIMENSIONS);
  const chunkStore = new InMemoryChunkStore();
  const deps = {
    documents: fakeDocuments(...docs),
    chunker: options.chunker ?? recursive(),
    embedder,
    vectorStore,
    chunkStore,
    writer,
    logger: noopLogger,
    now: () => new Date("2026-10-19T10:00:00.000Z"),
  };
  return { deps, embedder, writer, vectorStore, chunkStore, ids: docs.map((d) => d.id) };
}

describe("buildIndex", () => {
  it("chunks, embeds as documents, stores and writes the index", async () => {
    const { deps, embedder, writer, vectorStore, chunkStore, ids } = setup();
    const result = await buildIndex(deps, ids, settings());

    expect(result.status).toBe("built");
    expect(result.location).toBe("/index/recursive__fake-model");
    const { vectors, chunks, manifest } = writer.writes[0] as IndexContents;
    expect(chunks.length).toBeGreaterThan(3);
    expect(vectors).toHaveLength(chunks.length);
    expect(await vectorStore.count()).toBe(chunks.length);
    expect(await chunkStore.count()).toBe(chunks.length);
    expect(embedder.calls.every((call) => call.kind === "document")).toBe(true);
    // each vector is the embedding of its chunk's text, under that chunk's id
    for (const [i, chunk] of chunks.entries()) {
      expect(vectors[i]?.id).toBe(chunk.id);
      expect(vectors[i]?.vector).toEqual(vectorFor(chunk.text));
    }
    expect(manifest.counts).toEqual({
      documents: 2,
      chunks: chunks.length,
      parents: 0,
      vectors: chunks.length,
    });
  });

  it("embeds in batches of the given size", async () => {
    const { deps, embedder, ids } = setup();
    await buildIndex(deps, ids, settings({ batchSize: 3 }));
    expect(embedder.calls.length).toBeGreaterThan(1);
    expect(embedder.calls.every((call) => call.texts.length <= 3)).toBe(true);
    expect(embedder.calls.slice(0, -1).every((call) => call.texts.length === 3)).toBe(true);
  });

  it("embeds embedText when a chunk has one, and text otherwise", async () => {
    const inner = recursive();
    const chunker: Chunker = {
      name: inner.name,
      chunk: async (doc) =>
        (await inner.chunk(doc)).map((c, i) =>
          i === 0 ? { ...c, embedText: `Heading > ${c.text}` } : c,
        ),
    };
    const { deps, embedder, writer, ids } = setup({ chunker, docs: [docB] });
    await buildIndex(deps, ids, settings());
    const { chunks, vectors } = writer.writes[0] as IndexContents;
    expect(embedder.calls.flatMap((c) => c.texts)[0]).toBe(`Heading > ${chunks[0]?.text ?? ""}`);
    expect(vectors[1]?.vector).toEqual(vectorFor(chunks[1]?.text ?? ""));
  });

  it("stores the parents of a parent-child chunker without a vector", async () => {
    const inner = recursive();
    const chunker: Chunker = {
      name: inner.name,
      chunk: (doc) => inner.chunk(doc),
      parents: (doc) => Promise.resolve([createChunk(doc, inner.name, { start: 0, end: 30 })]),
    };
    const { deps, writer, vectorStore, chunkStore, ids } = setup({ chunker, docs: [docA] });
    await buildIndex(deps, ids, settings());
    const { chunks, vectors, manifest } = writer.writes[0] as IndexContents;
    expect(manifest.counts.parents).toBe(1);
    expect(chunks).toHaveLength(vectors.length + 1);
    expect(await vectorStore.count()).toBe(vectors.length);
    expect(await chunkStore.count()).toBe(chunks.length);
    // the parent is the last chunk and has no vector
    expect(vectors.some((v) => v.id === chunks.at(-1)?.id)).toBe(false);
  });

  it("records the settings, counts, timings, time and git commit in the manifest", async () => {
    const { deps, ids } = setup();
    const { manifest } = await buildIndex(deps, ids, settings());
    expect(manifest).toMatchObject({
      version: 1,
      namespace: "recursive__fake-model",
      createdAt: "2026-10-19T10:00:00.000Z",
      gitCommit: "abc1234",
      configHash: "c".repeat(64),
      chunker: { name: "recursive", tokenizer: "approx", maxTokens: 40, overlapTokens: 5 },
      embedder: { modelId: "fake:model", dimensions: DIMENSIONS, batchSize: 3 },
      documents: [...ids].sort(),
    });
    expect(manifest.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(manifest.timingsMs)).toEqual(["chunk", "embed", "store", "total"]);
  });

  describe("running again", () => {
    it("does nothing when the index is up to date", async () => {
      const first = setup();
      await buildIndex(first.deps, first.ids, settings());
      const second = { ...setup(), writer: first.writer };
      const result = await buildIndex(
        { ...second.deps, writer: first.writer },
        first.ids,
        settings(),
      );
      expect(result.status).toBe("skipped");
      expect(first.writer.writes).toHaveLength(1);
      expect(second.embedder.calls).toHaveLength(0);
    });

    it("gives the same fingerprint however the ids are ordered or repeated", async () => {
      const a = setup();
      await buildIndex(a.deps, a.ids, settings());
      const result = await buildIndex(
        { ...setup().deps, writer: a.writer },
        [...a.ids].reverse().concat(a.ids),
        settings(),
      );
      expect(result.status).toBe("skipped");
    });

    it("builds again with force", async () => {
      const first = setup();
      await buildIndex(first.deps, first.ids, settings());
      const result = await buildIndex(first.deps, first.ids, settings(), { force: true });
      expect(result.status).toBe("built");
      expect(first.writer.writes).toHaveLength(2);
    });

    it("builds again when a document is added", async () => {
      const first = setup();
      await buildIndex(first.deps, [docA.id], settings());
      const result = await buildIndex(first.deps, first.ids, settings());
      expect(result.status).toBe("built");
    });

    it("builds again when the chunk size changes", async () => {
      const first = setup();
      await buildIndex(first.deps, first.ids, settings());
      const result = await buildIndex(
        first.deps,
        first.ids,
        settings({
          chunker: { name: "recursive", tokenizer: "approx", maxTokens: 80, overlapTokens: 5 },
        }),
      );
      expect(result.status).toBe("built");
    });
  });

  describe("errors", () => {
    it("rejects an empty list of documents", async () => {
      const { deps } = setup();
      await expect(buildIndex(deps, [], settings())).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
      });
    });

    it("names a document that has not been ingested", async () => {
      const { deps } = setup({ docs: [docA] });
      const missing = docB.id;
      await expect(buildIndex(deps, [docA.id, missing], settings())).rejects.toThrow(
        new RegExp(missing),
      );
    });

    it("writes nothing when a step fails", async () => {
      const { deps, writer, ids } = setup();
      const broken: Embedder = {
        ...deps.embedder,
        embed: () => Promise.reject(new RagError("PROVIDER_UNAVAILABLE", "Ollama is down")),
      };
      await expect(buildIndex({ ...deps, embedder: broken }, ids, settings())).rejects.toThrow(
        "Ollama is down",
      );
      expect(writer.writes).toHaveLength(0);
    });

    it("rejects an embedder that returns the wrong number of vectors", async () => {
      const { deps, ids } = setup();
      const short: Embedder = { ...deps.embedder, embed: () => Promise.resolve([]) };
      await expect(buildIndex({ ...deps, embedder: short }, ids, settings())).rejects.toThrow(
        /returned 0 vectors/,
      );
    });

    it("rejects a vector store of another size than the embedder", async () => {
      const { deps, ids } = setup();
      await expect(
        buildIndex({ ...deps, vectorStore: new FlatVectorStore(DIMENSIONS + 1) }, ids, settings()),
      ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    });

    it("rejects settings that name another chunker", async () => {
      const { deps, ids } = setup();
      await expect(
        buildIndex(
          deps,
          ids,
          settings({
            chunker: { name: "fixed-size", tokenizer: "approx", maxTokens: 40, overlapTokens: 5 },
          }),
        ),
      ).rejects.toMatchObject({ code: "INTERNAL" });
    });
  });

  it("handles a document id type that is a DocId", () => {
    const id: DocId = docA.id;
    expect(typeof id).toBe("string");
  });
});

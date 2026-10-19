import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { INDEX_MANIFEST_VERSION, makeChunkId } from "../../core/index.js";
import type { Chunk, IndexContents, IndexManifest } from "../../core/index.js";
import { makeDocId } from "../../shared/index.js";
import { FileIndexReader } from "./file-index-reader.js";
import { FileIndexWriter } from "./file-index-writer.js";

const DOC = makeDocId("a".repeat(64));
const DIMENSIONS = 3;
const NAMESPACE = "recursive__ollama-all-minilm";

function chunk(text: string, start: number, extra: Partial<Chunk> = {}): Chunk {
  return {
    id: makeChunkId({
      docId: DOC,
      strategy: "recursive",
      charStart: start,
      charEnd: start + text.length,
      text,
    }),
    text,
    metadata: {
      docId: DOC,
      pageStart: 1,
      pageEnd: 2,
      sectionPath: ["Chapter 1", "1.1 Intro"],
      charStart: start,
      charEnd: start + text.length,
      strategy: "recursive",
    },
    ...extra,
  };
}

const parent = chunk("first chunk second chunk", 0);
const first = chunk("first chunk", 0, {
  parentId: parent.id,
  embedText: "Chapter 1 > first chunk",
});
const second = chunk("second chunk", 12, { parentId: parent.id });

const manifest = (overrides: Partial<IndexManifest> = {}): IndexManifest => ({
  version: INDEX_MANIFEST_VERSION,
  namespace: NAMESPACE,
  createdAt: "2026-10-19T10:00:00.000Z",
  gitCommit: "abc1234",
  configHash: "c".repeat(64),
  fingerprint: "f".repeat(64),
  chunker: { name: "recursive", tokenizer: "approx", maxTokens: 400, overlapTokens: 60 },
  embedder: { modelId: "ollama:all-minilm", dimensions: DIMENSIONS, batchSize: 32 },
  documents: [DOC],
  counts: { documents: 1, chunks: 3, parents: 1, vectors: 2 },
  timingsMs: { chunk: 1, embed: 2, store: 3, total: 6 },
  ...overrides,
});

const contents = (): IndexContents => ({
  manifest: manifest(),
  vectors: [
    { id: first.id, vector: Float32Array.of(1, 0, 0), metadata: first.metadata },
    { id: second.id, vector: Float32Array.of(0, 0.5, 0.25), metadata: second.metadata },
  ],
  chunks: [first, second, parent],
  keywordIndex: '{"formatVersion":1}',
});

describe("FileIndexReader", () => {
  let root: string;
  let reader: FileIndexReader;
  let folder: string;
  beforeEach(async () => {
    root = path.join(await mkdtemp(path.join(tmpdir(), "rag-reader-")), "index");
    reader = new FileIndexReader(root);
    folder = await new FileIndexWriter(root).write(contents());
  });
  afterEach(async () => {
    await rm(path.dirname(root), { recursive: true, force: true });
  });

  it("reads back exactly what the writer wrote", async () => {
    expect(await reader.read(NAMESPACE)).toEqual(contents());
  });

  it("keeps parents (chunks without a vector), parent ids and embedText", async () => {
    const read = await reader.read(NAMESPACE);
    expect(read?.chunks).toEqual([first, second, parent]);
    expect(read?.vectors.map((v) => v.id)).toEqual([first.id, second.id]);
  });

  it("reads an index that has no keyword index", async () => {
    const { manifest: m, vectors, chunks } = contents();
    const without: IndexContents = { manifest: m, vectors, chunks };
    await new FileIndexWriter(root).write(without);
    const read = await reader.read(NAMESPACE);
    expect(read).toBeDefined();
    expect(read?.keywordIndex).toBeUndefined();
  });

  it("returns undefined where no index was written", async () => {
    expect(await reader.read("fixed-size__ollama-all-minilm")).toBeUndefined();
  });

  it("says where an index is", () => {
    expect(reader.locationOf(NAMESPACE)).toBe(folder);
  });

  it.each(["../escape", "a/b", ".hidden"])("rejects the namespace %j", async (namespace) => {
    await expect(reader.read(namespace)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  describe("a damaged index is INDEX_CORRUPT, saying what and how to rebuild", () => {
    const corrupt = (problem: RegExp) =>
      expect(reader.read(NAMESPACE)).rejects.toThrow(
        expect.objectContaining({
          code: "INDEX_CORRUPT",
          message: expect.stringMatching(problem) as unknown,
        }) as Error,
      );

    it("vectors.bin cut short", async () => {
      const file = path.join(folder, "vectors.bin");
      await writeFile(file, (await readFile(file)).subarray(0, 10));
      await corrupt(/vectors\.bin is 10 bytes, but 2 vectors of 3 numbers need 24/);
      await expect(reader.read(NAMESPACE)).rejects.toThrow(/pnpm index --force/);
    });

    it("vectors.bin missing", async () => {
      await rm(path.join(folder, "vectors.bin"));
      await corrupt(/vectors\.bin cannot be read/);
    });

    it("chunks.jsonl missing", async () => {
      await rm(path.join(folder, "chunks.jsonl"));
      await corrupt(/chunks\.jsonl is missing/);
    });

    it("a line of chunks.jsonl that is not JSON, naming the line", async () => {
      const file = path.join(folder, "chunks.jsonl");
      const lines = (await readFile(file, "utf8")).split("\n");
      lines[1] = "{ not json";
      await writeFile(file, lines.join("\n"));
      await corrupt(/line 2 of chunks\.jsonl is not valid JSON/);
    });

    it("a line with the wrong shape", async () => {
      await writeFile(path.join(folder, "chunks.jsonl"), '{"indexed":true,"chunk":{"id":1}}\n');
      await corrupt(/line 1 of chunks\.jsonl has an unexpected shape/);
    });

    it("fewer chunks than the manifest says", async () => {
      const file = path.join(folder, "chunks.jsonl");
      const lines = (await readFile(file, "utf8")).split("\n").filter((l) => l !== "");
      await writeFile(file, `${lines.slice(0, 2).join("\n")}\n`);
      await corrupt(/manifest lists 3 chunks, chunks\.jsonl has 2/);
    });

    it("a different number of searchable chunks than the manifest says", async () => {
      const file = path.join(folder, "chunks.jsonl");
      const flipped = (await readFile(file, "utf8")).replace('"indexed":false', '"indexed":true');
      await writeFile(file, flipped);
      await corrupt(/manifest lists 2 vectors, chunks\.jsonl marks 3/);
    });

    it("a chunk listed twice", async () => {
      const file = path.join(folder, "chunks.jsonl");
      const lines = (await readFile(file, "utf8")).split("\n").filter((l) => l !== "");
      await writeFile(file, `${[lines[0], lines[0], lines[2]].join("\n")}\n`);
      await corrupt(/is listed twice/);
    });

    it("a manifest that is not JSON, or from another version", async () => {
      const file = path.join(folder, "manifest.json");
      await writeFile(file, "{ nope");
      await corrupt(/manifest\.json is not valid JSON/);
      await writeFile(file, JSON.stringify({ ...manifest(), version: 99 }));
      await corrupt(/another version/);
    });
  });
});

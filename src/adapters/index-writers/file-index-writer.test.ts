import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { INDEX_MANIFEST_VERSION, makeChunkId } from "../../core/index.js";
import type { Chunk, IndexContents, IndexManifest } from "../../core/index.js";
import { makeDocId } from "../../shared/index.js";
import { FileIndexWriter } from "./file-index-writer.js";

const DOC = makeDocId("a".repeat(64));
const DIMENSIONS = 3;

function chunk(text: string, start: number): Chunk {
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
      pageEnd: 1,
      sectionPath: [],
      charStart: start,
      charEnd: start + text.length,
      strategy: "recursive",
    },
  };
}

const manifest = (overrides: Partial<IndexManifest> = {}): IndexManifest => ({
  version: INDEX_MANIFEST_VERSION,
  namespace: "recursive__ollama-all-minilm",
  createdAt: "2026-10-19T10:00:00.000Z",
  gitCommit: null,
  configHash: "c".repeat(64),
  fingerprint: "f".repeat(64),
  chunker: { name: "recursive", tokenizer: "approx", maxTokens: 400, overlapTokens: 60 },
  embedder: { modelId: "ollama:all-minilm", dimensions: DIMENSIONS, batchSize: 32 },
  documents: [DOC],
  counts: { documents: 1, chunks: 3, parents: 1, vectors: 2 },
  timingsMs: { chunk: 1, embed: 2, store: 3, total: 6 },
  ...overrides,
});

describe("FileIndexWriter", () => {
  let root: string;
  let writer: FileIndexWriter;
  beforeEach(async () => {
    root = path.join(await mkdtemp(path.join(tmpdir(), "rag-index-")), "index");
    writer = new FileIndexWriter(root);
  });
  afterEach(async () => {
    await rm(path.dirname(root), { recursive: true, force: true });
  });

  const first = chunk("first chunk", 0);
  const second = chunk("second chunk", 12);
  const parent = chunk("first chunk second chunk", 0);
  const contents = (): IndexContents => ({
    manifest: manifest(),
    vectors: [
      { id: first.id, vector: Float32Array.of(1, 0, 0), metadata: first.metadata },
      { id: second.id, vector: Float32Array.of(0, 0.5, 0.25), metadata: second.metadata },
    ],
    chunks: [first, second, parent],
  });

  it("writes manifest.json, chunks.jsonl and vectors.bin into <root>/<namespace>/", async () => {
    const location = await writer.write(contents());
    expect(location).toBe(path.join(root, "recursive__ollama-all-minilm"));
    expect((await readdir(location)).sort()).toEqual([
      "chunks.jsonl",
      "manifest.json",
      "vectors.bin",
    ]);
  });

  it("writes one line per chunk, marking which have a vector", async () => {
    const location = await writer.write(contents());
    const lines = (await readFile(path.join(location, "chunks.jsonl"), "utf8"))
      .trimEnd()
      .split("\n")
      .map((l) => JSON.parse(l) as { indexed: boolean; chunk: Chunk });
    expect(lines.map((l) => l.indexed)).toEqual([true, true, false]);
    expect(lines.map((l) => l.chunk)).toEqual([first, second, parent]);
  });

  it("writes the vectors of the indexed chunks as raw float32, in chunk order", async () => {
    const location = await writer.write(contents());
    const bytes = await readFile(path.join(location, "vectors.bin"));
    expect(bytes.length).toBe(2 * DIMENSIONS * 4);
    const floats = new Float32Array(new Uint8Array(bytes).buffer);
    expect([...floats]).toEqual([1, 0, 0, 0, 0.5, 0.25]);
  });

  it("reads the manifest back", async () => {
    await writer.write(contents());
    expect(await writer.readManifest("recursive__ollama-all-minilm")).toEqual(manifest());
  });

  it("reads no manifest where no index was written", async () => {
    expect(await writer.readManifest("recursive__ollama-all-minilm")).toBeUndefined();
  });

  it("replaces an earlier index completely and leaves no temporary folder", async () => {
    await writer.write(contents());
    await writer.write({
      manifest: manifest({ fingerprint: "e".repeat(64) }),
      vectors: [],
      chunks: [],
    });
    expect((await writer.readManifest("recursive__ollama-all-minilm"))?.fingerprint).toBe(
      "e".repeat(64),
    );
    const location = writer.locationOf("recursive__ollama-all-minilm");
    expect((await readFile(path.join(location, "vectors.bin"))).length).toBe(0);
    expect(await readdir(root)).toEqual(["recursive__ollama-all-minilm"]);
  });

  it("rejects a damaged manifest, saying to re-run with --force", async () => {
    const location = await writer.write(contents());
    await writeFile(path.join(location, "manifest.json"), "{ not json");
    await expect(writer.readManifest("recursive__ollama-all-minilm")).rejects.toThrow(/damaged/);
    await writeFile(path.join(location, "manifest.json"), JSON.stringify({ version: 99 }));
    await expect(writer.readManifest("recursive__ollama-all-minilm")).rejects.toThrow(/--force/);
  });

  it("rejects a vector of the wrong length and writes nothing", async () => {
    const bad = contents();
    await expect(
      writer.write({
        ...bad,
        vectors: [{ id: first.id, vector: Float32Array.of(1, 0), metadata: first.metadata }],
      }),
    ).rejects.toMatchObject({ code: "INTERNAL" });
    expect(await readdir(path.dirname(root))).toEqual([]);
  });

  it("rejects a vector whose chunk is not in the index", async () => {
    const stray = chunk("stray", 99);
    await expect(
      writer.write({
        ...contents(),
        vectors: [{ id: stray.id, vector: Float32Array.of(1, 0, 0), metadata: stray.metadata }],
      }),
    ).rejects.toMatchObject({ code: "INTERNAL" });
  });

  it.each(["../escape", "a/b", "", ".hidden", "a..b"])("rejects the namespace %j", (namespace) => {
    expect(() => writer.locationOf(namespace)).toThrow(/Not an index namespace/);
  });
});

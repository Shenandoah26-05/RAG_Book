import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
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

function chunk(text: string, start: number, parentId?: Chunk["id"]): Chunk {
  return {
    id: makeChunkId({
      docId: DOC,
      strategy: "recursive",
      charStart: start,
      charEnd: start + text.length,
      text,
    }),
    text,
    ...(parentId === undefined ? {} : { parentId }),
    metadata: {
      docId: DOC,
      pageStart: 2,
      pageEnd: 3,
      sectionPath: ["Chapter 1"],
      charStart: start,
      charEnd: start + text.length,
      strategy: "recursive",
    },
  };
}

const manifest = (): IndexManifest => ({
  version: INDEX_MANIFEST_VERSION,
  namespace: NAMESPACE,
  createdAt: "2026-10-19T10:00:00.000Z",
  gitCommit: null,
  configHash: "c".repeat(64),
  fingerprint: "f".repeat(64),
  chunker: { name: "recursive", tokenizer: "approx", maxTokens: 400, overlapTokens: 60 },
  embedder: { modelId: "ollama:all-minilm", dimensions: DIMENSIONS, batchSize: 32 },
  documents: [DOC],
  counts: { documents: 1, chunks: 3, parents: 1, vectors: 2 },
  timingsMs: { total: 6 },
});

describe("FileIndexReader", () => {
  let root: string;
  let reader: FileIndexReader;
  beforeEach(async () => {
    root = path.join(await mkdtemp(path.join(tmpdir(), "rag-index-read-")), "index");
    reader = new FileIndexReader(root);
  });
  afterEach(async () => {
    await rm(path.dirname(root), { recursive: true, force: true });
  });

  const parent = chunk("first chunk second chunk", 0);
  const first = chunk("first chunk", 0, parent.id);
  const second = chunk("second chunk", 12, parent.id);
  const contents = (): IndexContents => ({
    manifest: manifest(),
    vectors: [
      { id: first.id, vector: Float32Array.of(1, 0, 0), metadata: first.metadata },
      { id: second.id, vector: Float32Array.of(0, 0.5, 0.25), metadata: second.metadata },
    ],
    chunks: [first, second, parent],
    keywordIndex: '{"kw":true}',
  });
  const save = async (): Promise<string> => new FileIndexWriter(root).write(contents());

  it("reads back what the writer saved", async () => {
    await save();
    const read = await reader.read(NAMESPACE);
    expect(read?.manifest).toEqual(manifest());
    expect(read?.chunks).toEqual([first, second, parent]);
    expect(read?.vectors.map((v) => [v.id, [...v.vector]])).toEqual([
      [first.id, [1, 0, 0]],
      [second.id, [0, 0.5, 0.25]],
    ]);
    expect(read?.vectors[0]?.metadata).toEqual(first.metadata);
    expect(read?.keywordIndex).toBe('{"kw":true}');
  });

  it("leaves the keyword index out when there is none", async () => {
    await new FileIndexWriter(root).write({ ...contents(), keywordIndex: undefined });
    expect((await reader.read(NAMESPACE))?.keywordIndex).toBeUndefined();
  });

  it("returns undefined when there is no index", async () => {
    expect(await reader.read(NAMESPACE)).toBeUndefined();
  });

  it("rejects a vector file of the wrong size, naming the file", async () => {
    const folder = await save();
    await truncate(path.join(folder, "vectors.bin"), 8);
    await expect(reader.read(NAMESPACE)).rejects.toMatchObject({
      code: "INDEX_CORRUPT",
      message: expect.stringContaining("vectors.bin") as string,
    });
  });

  it("rejects a chunk file with a line that is not a chunk", async () => {
    const folder = await save();
    await writeFile(path.join(folder, "chunks.jsonl"), '{"indexed":true}\n');
    await expect(reader.read(NAMESPACE)).rejects.toMatchObject({
      code: "INDEX_CORRUPT",
      message: expect.stringContaining("line 1") as string,
    });
  });

  it("rejects a chunk file that disagrees with the manifest", async () => {
    const folder = await save();
    const line = JSON.stringify({ indexed: false, chunk: parent });
    await writeFile(path.join(folder, "chunks.jsonl"), `${line}\n`);
    await expect(reader.read(NAMESPACE)).rejects.toMatchObject({ code: "INDEX_CORRUPT" });
  });

  it("rejects a missing file as INDEX_CORRUPT", async () => {
    const folder = await save();
    await rm(path.join(folder, "vectors.bin"));
    await expect(reader.read(NAMESPACE)).rejects.toMatchObject({ code: "INDEX_CORRUPT" });
  });
});

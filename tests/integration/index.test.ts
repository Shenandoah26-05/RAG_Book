import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileDocumentStore } from "../../src/adapters/index.js";
import { buildIndexer, describeIndex } from "../../src/composition/index.js";
import { makeDocument } from "../../src/testing/make-document.testing.js";
import { noopLogger } from "../../src/shared/index.js";

const DIMENSIONS = 384;

/** Stands in for Ollama: one repeatable vector per input text. */
function fakeOllama(): typeof fetch & { inputs: string[] } {
  const inputs: string[] = [];
  const fn = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
    const sent = JSON.parse(init?.body as string) as { input: string[] };
    inputs.push(...sent.input);
    const embeddings = sent.input.map((text) =>
      Array.from(
        { length: DIMENSIONS },
        (_, i) => ((text.charCodeAt(i % text.length) + i) % 7) + 1,
      ),
    );
    return Promise.resolve(
      new Response(JSON.stringify({ embeddings }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  });
  return Object.assign(fn as unknown as typeof fetch, { inputs });
}

describe("pnpm index, end to end with a fake Ollama", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "rag-index-e2e-"));
    const doc = makeDocument([
      "Vectors are lists of numbers that can be compared. ".repeat(20),
      "Chunks are passages of a document. Each chunk gets one vector. ".repeat(20),
    ]);
    await new FileDocumentStore(path.join(dir, "processed")).save(doc);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const indexer = (fetchFn: typeof fetch) =>
    buildIndexer({
      argv: ["--chunking.max-tokens", "100", "--chunking.overlap-tokens", "10"],
      env: {},
      processedDir: path.join(dir, "processed"),
      indexDir: path.join(dir, "index"),
      cacheDir: path.join(dir, "cache"),
      logger: noopLogger,
      fetch: fetchFn,
      gitCommit: "deadbeef",
    });

  it("writes data/index/<chunker>__<embedder>/ with a manifest, and a second run does nothing", async () => {
    const fetchFn = fakeOllama();
    const first = await (
      await indexer(fetchFn)
    ).run({
      chunker: "recursive",
      embedder: "ollama:all-minilm",
    });

    expect(first.status).toBe("built");
    const folder = path.join(dir, "index", "recursive__ollama-all-minilm");
    expect(first.location).toBe(folder);
    expect((await readdir(folder)).sort()).toEqual([
      "chunks.jsonl",
      "manifest.json",
      "vectors.bin",
    ]);

    const manifest = JSON.parse(await readFile(path.join(folder, "manifest.json"), "utf8")) as {
      gitCommit: string;
      counts: { vectors: number; documents: number };
      chunker: { name: string; maxTokens: number };
      embedder: { modelId: string; dimensions: number };
    };
    expect(manifest.gitCommit).toBe("deadbeef");
    expect(manifest.chunker).toMatchObject({ name: "recursive", maxTokens: 100 });
    expect(manifest.embedder).toMatchObject({
      modelId: "ollama:all-minilm",
      dimensions: DIMENSIONS,
    });
    expect(manifest.counts.documents).toBe(1);
    expect(manifest.counts.vectors).toBeGreaterThan(1);
    const bytes = (await readFile(path.join(folder, "vectors.bin"))).length;
    expect(bytes).toBe(manifest.counts.vectors * DIMENSIONS * 4);

    const requests = fetchFn.inputs.length;
    const second = await (
      await indexer(fetchFn)
    ).run({
      chunker: "recursive",
      embedder: "ollama:all-minilm",
    });
    expect(second.status).toBe("skipped");
    expect(fetchFn.inputs.length).toBe(requests);
    expect(describeIndex(second)).toMatch(/up to date/);
  });

  it("rebuilds from the embedding cache without asking Ollama again", async () => {
    const fetchFn = fakeOllama();
    await (await indexer(fetchFn)).run({});
    const asked = fetchFn.inputs.length;
    const forced = await (await indexer(fetchFn)).run({ force: true });
    expect(forced.status).toBe("built");
    expect(fetchFn.inputs.length).toBe(asked);
  });

  it("keeps two variants side by side", async () => {
    const fetchFn = fakeOllama();
    const run = await indexer(fetchFn);
    await run.run({ chunker: "recursive" });
    await run.run({ chunker: "fixed-size" });
    expect((await readdir(path.join(dir, "index"))).sort()).toEqual([
      "fixed-size__ollama-all-minilm",
      "recursive__ollama-all-minilm",
    ]);
  });

  it("names the chunkers that exist for an unknown one, before reading any file", async () => {
    const run = await indexer(fakeOllama());
    await expect(run.run({ chunker: "magic" })).rejects.toThrow(/Known strategies/);
  });

  it("says to run ingest when there are no processed documents", async () => {
    await rm(path.join(dir, "processed"), { recursive: true });
    const run = await indexer(fakeOllama());
    await expect(run.run({})).rejects.toThrow(/pnpm ingest/);
  });
});

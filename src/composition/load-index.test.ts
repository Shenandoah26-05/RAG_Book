import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileIndexReader } from "../adapters/index.js";
import { DEFAULT_CONFIG } from "../config/index.js";
import type { ChunkId } from "../core/index.js";
import { noopLogger } from "../shared/index.js";
import {
  fixtureContents,
  NAMESPACE,
  purr,
  QUESTION_VECTOR,
  SEARCHABLE,
  writeFixtureIndex,
  young,
} from "./search-fixture.testing.js";
import { loadIndex, openIndex } from "./load-index.js";

const settings = DEFAULT_CONFIG.vectorStore;

describe("loadIndex", () => {
  it("fills a vector store, a chunk store and a keyword index from what was read", async () => {
    const index = await loadIndex(fixtureContents(), settings);

    expect(index.manifest.embedder.modelId).toBe("ollama:all-minilm");
    expect(index.hasParents).toBe(false);
    expect(await index.vectorStore.count()).toBe(SEARCHABLE.length);
    expect(await index.chunkStore.count()).toBe(SEARCHABLE.length);
    // the vectors really are searchable, and the chunk store turns ids back into chunks
    expect((await index.vectorStore.search(QUESTION_VECTOR, 1))[0]?.id).toBe(young.id);
    expect(await index.chunkStore.get([young.id])).toEqual([young]);
    // so is the keyword index
    expect((await index.keywordIndex?.search("purr", 3))?.[0]?.id).toBe(purr.id);
  });

  it("counts parents in the chunk store but not in the vector store, and says so", async () => {
    const parent = { ...young, id: "parent-1" as ChunkId };
    const index = await loadIndex(fixtureContents({ parents: [parent] }), settings);
    expect(index.hasParents).toBe(true);
    expect(await index.chunkStore.count()).toBe(SEARCHABLE.length + 1);
    expect(await index.vectorStore.count()).toBe(SEARCHABLE.length);
  });

  it("has no keyword index when the index was built without one", async () => {
    const index = await loadIndex(fixtureContents({ withKeyword: false }), settings);
    expect(index.keywordIndex).toBeUndefined();
  });

  it("rejects an unknown vector store", async () => {
    await expect(
      loadIndex(fixtureContents(), { ...settings, type: "magic" }),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });
});

describe("openIndex", () => {
  let root: string;
  beforeEach(async () => {
    root = path.join(await mkdtemp(path.join(tmpdir(), "rag-open-")), "index");
  });
  afterEach(async () => {
    await rm(path.dirname(root), { recursive: true, force: true });
  });

  it("reads the index of a namespace and loads it, saying where it came from", async () => {
    await writeFixtureIndex(root);
    const index = await openIndex(new FileIndexReader(root), NAMESPACE, settings);
    expect(index.namespace).toBe(NAMESPACE);
    expect(index.location).toBe(path.join(root, NAMESPACE));
    expect(index.loadMs).toBeGreaterThanOrEqual(0);
    expect(await index.vectorStore.count()).toBe(SEARCHABLE.length);
  });

  it("logs the load time", async () => {
    await writeFixtureIndex(root);
    const lines: { message: string; fields?: unknown }[] = [];
    const logger = {
      ...noopLogger,
      info: (message: string, fields?: unknown) => lines.push({ message, fields }),
    };
    await openIndex(new FileIndexReader(root), NAMESPACE, settings, logger);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.message).toBe("index loaded");
    expect(lines[0]?.fields).toMatchObject({ namespace: NAMESPACE, chunks: SEARCHABLE.length });
  });

  it("says how to build an index that is not there", async () => {
    await expect(openIndex(new FileIndexReader(root), NAMESPACE, settings)).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      message: expect.stringContaining("pnpm index") as unknown,
    });
  });

  it("rejects a damaged keyword index as INDEX_CORRUPT", async () => {
    await writeFixtureIndex(root);
    await writeFile(path.join(root, NAMESPACE, "keyword.json"), "{ nope");
    await expect(openIndex(new FileIndexReader(root), NAMESPACE, settings)).rejects.toMatchObject({
      code: "INDEX_CORRUPT",
    });
  });
});

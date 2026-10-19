import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileIndexReader } from "../adapters/index.js";
import { noopLogger } from "../shared/index.js";
import {
  NAMESPACE,
  QUESTION_VECTOR,
  SEARCHABLE,
  purr,
  writeFixtureIndex,
  young,
} from "./search-fixture.testing.js";
import { loadIndex } from "./load-index.js";

describe("loadIndex", () => {
  let root: string;
  beforeEach(async () => {
    root = path.join(await mkdtemp(path.join(tmpdir(), "rag-load-")), "index");
  });
  afterEach(async () => {
    await rm(path.dirname(root), { recursive: true, force: true });
  });

  it("fills a vector store, a chunk store and a keyword index from the saved folder", async () => {
    await writeFixtureIndex(root);
    const index = await loadIndex(new FileIndexReader(root), NAMESPACE);

    expect(index.namespace).toBe(NAMESPACE);
    expect(index.location).toBe(path.join(root, NAMESPACE));
    expect(index.manifest.embedder.modelId).toBe("ollama:all-minilm");
    expect(await index.vectorStore.count()).toBe(SEARCHABLE.length);
    expect(await index.chunkStore.count()).toBe(SEARCHABLE.length);
    // the vectors really are searchable, and the chunk store turns ids back into chunks
    const hits = await index.vectorStore.search(QUESTION_VECTOR, 1);
    expect(hits[0]?.id).toBe(young.id);
    expect(await index.chunkStore.get([young.id])).toEqual([young]);
    // so is the keyword index
    const words = await index.keywordIndex?.search("purr", 3);
    expect(words?.[0]?.id).toBe(purr.id);
  });

  it("counts parents in the chunk store but not in the vector store", async () => {
    const parent = { ...young, id: "parent-1" as typeof young.id };
    await writeFixtureIndex(root, { parents: [parent] });
    const index = await loadIndex(new FileIndexReader(root), NAMESPACE);
    expect(await index.chunkStore.count()).toBe(SEARCHABLE.length + 1);
    expect(await index.vectorStore.count()).toBe(SEARCHABLE.length);
  });

  it("has no keyword index when the index was built without one", async () => {
    await writeFixtureIndex(root, { withKeyword: false });
    expect((await loadIndex(new FileIndexReader(root), NAMESPACE)).keywordIndex).toBeUndefined();
  });

  it("logs the load time", async () => {
    await writeFixtureIndex(root);
    const lines: { message: string; fields?: unknown }[] = [];
    const logger = {
      ...noopLogger,
      info: (message: string, fields?: unknown) => lines.push({ message, fields }),
    };
    await loadIndex(new FileIndexReader(root), NAMESPACE, logger);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.message).toBe("index loaded");
    expect(lines[0]?.fields).toMatchObject({ namespace: NAMESPACE, chunks: SEARCHABLE.length });
  });

  it("says how to build an index that is not there", async () => {
    await expect(loadIndex(new FileIndexReader(root), NAMESPACE)).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      message: expect.stringContaining("pnpm index") as unknown,
    });
  });

  it("rejects a damaged keyword index as INDEX_CORRUPT", async () => {
    await writeFixtureIndex(root);
    await writeFile(path.join(root, NAMESPACE, "keyword.json"), "{ nope");
    await expect(loadIndex(new FileIndexReader(root), NAMESPACE)).rejects.toMatchObject({
      code: "INDEX_CORRUPT",
    });
  });
});

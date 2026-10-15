import { describe, expect, it } from "vitest";
import type { Chunk, ChunkId, DocId } from "../../core/index.js";
import { InMemoryChunkStore } from "./in-memory-chunk-store.js";

const chunk = (id: string, text = `text of ${id}`): Chunk => ({
  id: id as ChunkId,
  text,
  metadata: {
    docId: "doc" as DocId,
    pageStart: 1,
    pageEnd: 1,
    sectionPath: [],
    charStart: 0,
    charEnd: text.length,
    strategy: "recursive",
  },
});

describe("InMemoryChunkStore", () => {
  it("starts empty", async () => {
    expect(await new InMemoryChunkStore().count()).toBe(0);
  });

  it("returns the chunks asked for, in the order asked, with undefined for a missing id", async () => {
    const store = new InMemoryChunkStore();
    await store.put([chunk("a"), chunk("b"), chunk("c")]);
    expect(await store.get(["c", "missing", "a"] as ChunkId[])).toEqual([
      chunk("c"),
      undefined,
      chunk("a"),
    ]);
  });

  it("returns nothing for no ids", async () => {
    expect(await new InMemoryChunkStore().get([])).toEqual([]);
  });

  it("replaces a chunk that is put again, without changing the count", async () => {
    const store = new InMemoryChunkStore();
    await store.put([chunk("a", "old")]);
    await store.put([chunk("a", "new")]);
    expect(await store.count()).toBe(1);
    expect((await store.get(["a" as ChunkId]))[0]?.text).toBe("new");
  });

  it("puts an empty batch without changing anything", async () => {
    const store = new InMemoryChunkStore();
    await store.put([]);
    expect(await store.count()).toBe(0);
  });

  it("deletes the given ids and ignores unknown ones", async () => {
    const store = new InMemoryChunkStore();
    await store.put([chunk("a"), chunk("b")]);
    await store.delete(["a", "never-stored"] as ChunkId[]);
    expect(await store.count()).toBe(1);
    expect(await store.get(["a", "b"] as ChunkId[])).toEqual([undefined, chunk("b")]);
  });

  it("holds chunks that are not in any vector index, such as parents", async () => {
    const store = new InMemoryChunkStore();
    const parent = chunk("parent", "a long passage that is never searched directly");
    await store.put([parent, { ...chunk("child"), parentId: parent.id }]);
    const [child] = await store.get(["child" as ChunkId]);
    const [found] = await store.get(child?.parentId === undefined ? [] : [child.parentId]);
    expect(found).toEqual(parent);
  });
});

import { describe, expect, it } from "vitest";
import type { ChunkId, DocId, MetadataFilter, VectorRecord } from "../../core/index.js";
import { FlatVectorStore } from "./flat-vector-store.js";

/** Ten chunks in two chapters. Every chapter 1 chunk is closer to the query than any of chapter 2. */
function chapters(): VectorRecord[] {
  return Array.from({ length: 10 }, (_, i) => {
    const chapter = i < 5 ? "Chapter 1" : "Chapter 2";
    return {
      id: `c${i.toString()}` as ChunkId,
      vector: Float32Array.from([1, i * 0.1]), // later chunks point further from the query [1, 0]
      metadata: {
        docId: "book" as DocId,
        pageStart: i + 1,
        pageEnd: i + 1,
        sectionPath: [chapter, `${chapter} part`],
        charStart: 0,
        charEnd: 1,
        strategy: "recursive",
      },
    };
  });
}

const QUERY = Float32Array.from([1, 0]);

async function store(): Promise<FlatVectorStore> {
  const flat = new FlatVectorStore(2);
  await flat.upsert(chapters());
  return flat;
}

const ids = (hits: readonly { readonly id: string }[]): string[] => hits.map((h) => h.id);

describe("FlatVectorStore: filters are applied before scoring", () => {
  it("returns k hits from the chapter asked for, though the whole index ranks it last", async () => {
    const filter: MetadataFilter = [{ kind: "section", path: ["Chapter 2"] }];
    const hits = await (await store()).search(QUERY, 3, filter);
    expect(ids(hits)).toEqual(["c5", "c6", "c7"]);
  });

  it("post-filtering the top k would have returned nothing: the reason to filter first", async () => {
    const flat = await store();
    const filter: MetadataFilter = [{ kind: "section", path: ["Chapter 2"] }];
    const chapter2 = new Set(ids(await flat.search(QUERY, 100, filter)));
    const postFiltered = (await flat.search(QUERY, 3)).filter((h) => chapter2.has(h.id));
    expect(postFiltered).toEqual([]);
    expect(await flat.search(QUERY, 3, filter)).toHaveLength(3);
  });

  it("restricts to a page range, and a section, and both together", async () => {
    const flat = await store();
    expect(ids(await flat.search(QUERY, 10, [{ kind: "pageRange", from: 4, to: 6 }]))).toEqual([
      "c3",
      "c4",
      "c5",
    ]);
    expect(
      ids(
        await flat.search(QUERY, 10, [{ kind: "section", path: ["Chapter 1", "Chapter 1 part"] }]),
      ),
    ).toEqual(["c0", "c1", "c2", "c3", "c4"]);
    expect(
      ids(
        await flat.search(QUERY, 10, [
          { kind: "section", path: ["chapter 2"] },
          { kind: "pageRange", to: 7 },
        ]),
      ),
    ).toEqual(["c5", "c6"]);
  });

  it("rejects a blank section path instead of returning nothing", async () => {
    await expect((await store()).search(QUERY, 3, [{ kind: "section", path: [] }])).rejects.toThrow(
      /section path/,
    );
  });
});

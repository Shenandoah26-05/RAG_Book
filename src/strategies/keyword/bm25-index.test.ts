import { describe, expect, it } from "vitest";
import type { Chunk, ChunkId, ChunkMetadata, DocId, MetadataFilter } from "../../core/index.js";
import { RagError } from "../../shared/index.js";
import { analyze, ENGLISH_STOPWORDS } from "./analyzer.js";
import { Bm25Index } from "./bm25-index.js";

const meta = (overrides: Partial<ChunkMetadata> = {}): ChunkMetadata => ({
  docId: "doc-1" as DocId,
  pageStart: 1,
  pageEnd: 1,
  sectionPath: [],
  charStart: 0,
  charEnd: 1,
  strategy: "recursive",
  ...overrides,
});
const chunk = (id: string, text: string, metadata = meta(), embedText?: string): Chunk => ({
  id: id as ChunkId,
  text,
  ...(embedText === undefined ? {} : { embedText }),
  metadata,
});

async function codeOf(promise: Promise<unknown> | (() => unknown)): Promise<string | undefined> {
  try {
    await (typeof promise === "function" ? promise() : promise);
  } catch (error) {
    return error instanceof RagError ? error.code : "not a RagError";
  }
  return undefined;
}

/**
 * Three chunks, worked out by hand with k1 = 1.2 and b = 0.75.
 *
 *   d1 = "apple banana apple"           3 terms
 *   d2 = "banana cherry"                2 terms
 *   d3 = "cherry cherry cherry date"    4 terms
 *
 * N = 3 and the average length is (3 + 2 + 4) / 3 = 3. The query is "apple cherry".
 *
 *   idf(apple)  = ln(1 + (3 - 1 + 0.5) / (1 + 0.5)) = ln(2.6667) = 0.980829   (df = 1)
 *   idf(cherry) = ln(1 + (3 - 2 + 0.5) / (2 + 0.5)) = ln(1.6)    = 0.470004   (df = 2)
 *
 *   d1: apple tf 2, length 3: 1 - 0.75 + 0.75 * 3/3 = 1.00
 *       0.980829 * (2 * 2.2) / (2 + 1.2 * 1.00) = 0.980829 * 1.375000 = 1.348640
 *   d2: cherry tf 1, length 2: 1 - 0.75 + 0.75 * 2/3 = 0.75
 *       0.470004 * (1 * 2.2) / (1 + 1.2 * 0.75) = 0.470004 * 1.157895 = 0.544215
 *   d3: cherry tf 3, length 4: 1 - 0.75 + 0.75 * 4/3 = 1.25
 *       0.470004 * (3 * 2.2) / (3 + 1.2 * 1.25) = 0.470004 * 1.466667 = 0.689339
 *
 * So the order is d1, d3, d2: one occurrence of a rare word beats a few of a common one, and
 * d3's three "cherry" do not make it three times as good as d2's one.
 */
function handExample(options: ConstructorParameters<typeof Bm25Index>[0] = {}): Bm25Index {
  const index = new Bm25Index(options);
  index.add([
    chunk("d1", "apple banana apple"),
    chunk("d2", "banana cherry"),
    chunk("d3", "cherry cherry cherry date"),
  ]);
  return index;
}

describe("Bm25Index: the hand-worked example", () => {
  it("scores and orders the three chunks as computed by hand", async () => {
    const hits = await handExample().search("apple cherry", 10);
    expect(hits.map((h) => h.id)).toEqual(["d1", "d3", "d2"]);
    expect(hits[0]?.score).toBeCloseTo(1.34864, 5);
    expect(hits[1]?.score).toBeCloseTo(0.689339, 5);
    expect(hits[2]?.score).toBeCloseTo(0.544215, 5);
  });

  it("scores one term on its own", async () => {
    const hits = await handExample().search("banana", 10);
    // df = 2: idf = 0.470004. d1: tf 1, length 3 -> norm 1.00 -> 1 * 2.2 / 2.2 = 1.000000.
    // d2: tf 1, length 2 -> norm 0.75 -> 2.2 / 1.9 = 1.157895.
    expect(hits.map((h) => h.id)).toEqual(["d2", "d1"]);
    expect(hits[0]?.score).toBeCloseTo(0.470004 * 1.157895, 5);
    expect(hits[1]?.score).toBeCloseTo(0.470004, 5);
  });

  it("returns only the best k", async () => {
    const hits = await handExample().search("apple cherry", 2);
    expect(hits.map((h) => h.id)).toEqual(["d1", "d3"]);
  });

  it("counts a term repeated in the query once", async () => {
    const index = handExample();
    expect(await index.search("apple apple apple", 5)).toEqual(await index.search("apple", 5));
  });

  it("gives nothing for a query with no usable term or no match", async () => {
    const index = handExample();
    expect(await index.search("", 5)).toEqual([]);
    expect(await index.search("!!!", 5)).toEqual([]);
    expect(await index.search("zebra", 5)).toEqual([]);
    expect(await new Bm25Index().search("apple", 5)).toEqual([]);
  });
});

describe("Bm25Index: k1, b and the analyzer", () => {
  it("with b = 0 length is ignored: equal tf scores equally", async () => {
    const index = new Bm25Index({ b: 0 });
    index.add([chunk("short", "apple pear"), chunk("long", "apple pear plum fig lime date kiwi")]);
    const [first, second] = await index.search("apple", 2);
    expect(first?.score).toBe(second?.score);
  });

  it("with b = 1 the longer chunk scores lower for the same tf", async () => {
    const index = new Bm25Index({ b: 1 });
    index.add([chunk("short", "apple pear"), chunk("long", "apple pear plum fig lime date kiwi")]);
    expect((await index.search("apple", 2)).map((h) => h.id)).toEqual(["short", "long"]);
  });

  it("with k1 = 0 a term counts once, however often it occurs", async () => {
    const index = new Bm25Index({ k1: 0 });
    index.add([chunk("once", "apple pear"), chunk("often", "apple apple apple pear")]);
    const [first, second] = await index.search("apple", 2);
    expect(first?.score).toBe(second?.score);
  });

  it("a larger k1 lets a repeated term count for more", async () => {
    const make = (k1: number): Bm25Index => {
      const index = new Bm25Index({ k1, b: 0 });
      index.add([chunk("once", "apple pear"), chunk("often", "apple apple apple pear")]);
      return index;
    };
    const ratio = async (k1: number): Promise<number> => {
      const hits = await make(k1).search("apple", 2);
      return (hits[0]?.score ?? 0) / (hits[1]?.score ?? 1);
    };
    expect(await ratio(3)).toBeGreaterThan(await ratio(0.3));
  });

  it("leaves stopwords out of the index and out of queries", async () => {
    const index = new Bm25Index({ stopwords: ENGLISH_STOPWORDS });
    index.add([chunk("a", "the cat sat on the mat"), chunk("b", "the dog")]);
    expect(await index.search("the", 5)).toEqual([]);
    expect((await index.search("the cat", 5)).map((h) => h.id)).toEqual(["a"]);
  });

  it("matches a stopword given in capitals", async () => {
    const index = new Bm25Index({ stopwords: ["The"] });
    index.add([chunk("a", "the cat")]);
    expect(await index.search("the", 5)).toEqual([]);
  });

  it("is case and punctuation blind", async () => {
    const index = new Bm25Index();
    index.add([chunk("a", "Vectors, vectors; VECTORS!")]);
    expect((await index.search("vectors", 1)).map((h) => h.id)).toEqual(["a"]);
  });

  it("indexes embedText instead of text when there is one", async () => {
    const index = new Bm25Index();
    index.add([chunk("a", "it is cold", meta(), "Chapter 3 > Weather: it is cold")]);
    expect((await index.search("weather", 1)).map((h) => h.id)).toEqual(["a"]);
  });

  it("rejects a k1 or b out of range", () => {
    expect(() => new Bm25Index({ k1: -1 })).toThrow(/k1/);
    expect(() => new Bm25Index({ b: 1.5 })).toThrow(/b must/);
    expect(() => new Bm25Index({ b: Number.NaN })).toThrow(RagError);
  });
});

describe("Bm25Index: ties, filters and rules", () => {
  it("orders equal scores by id", async () => {
    const index = new Bm25Index();
    index.add([chunk("c", "apple"), chunk("a", "apple"), chunk("b", "apple")]);
    expect((await index.search("apple", 3)).map((h) => h.id)).toEqual(["a", "b", "c"]);
  });

  it("applies a filter, and the score does not depend on it", async () => {
    const index = new Bm25Index();
    index.add([
      chunk("p1", "apple pear", meta({ pageStart: 1, pageEnd: 1 })),
      chunk("p9", "apple apple", meta({ pageStart: 9, pageEnd: 9, docId: "doc-2" as DocId })),
    ]);
    const all = await index.search("apple", 5);
    const filter: MetadataFilter = [{ kind: "equals", field: "docId", value: "doc-1" }];
    const some = await index.search("apple", 5, filter);
    expect(some.map((h) => h.id)).toEqual(["p1"]);
    expect(some[0]?.score).toBe(all.find((h) => h.id === "p1")?.score);
    expect(await index.search("apple", 5, [{ kind: "pageRange", from: 5 }])).toHaveLength(1);
    expect(await index.search("apple", 5, [{ kind: "pageRange", from: 50 }])).toEqual([]);
  });

  it("rejects an invalid filter and an invalid k", async () => {
    const index = handExample();
    expect(await codeOf(index.search("apple", 0))).toBe("INVALID_ARGUMENT");
    expect(await codeOf(index.search("apple", 1.5))).toBe("INVALID_ARGUMENT");
    expect(await codeOf(index.search("apple", 1, [{ kind: "pageRange", from: 5, to: 2 }]))).toBe(
      "INVALID_ARGUMENT",
    );
  });

  it("refuses a chunk id twice, and adds nothing from that batch", async () => {
    const index = handExample();
    expect(
      await codeOf(() => {
        index.add([chunk("new", "fig"), chunk("d1", "fig")]);
      }),
    ).toBe("INVALID_ARGUMENT");
    expect(
      await codeOf(() => {
        index.add([chunk("x", "fig"), chunk("x", "fig")]);
      }),
    ).toBe("INVALID_ARGUMENT");
    expect(index.count()).toBe(3);
    expect(await index.search("fig", 5)).toEqual([]);
  });

  it("counts its chunks, an empty chunk included, and can be added to in steps", async () => {
    const index = new Bm25Index();
    index.add([chunk("a", "apple")]);
    index.add([chunk("empty", "...")]);
    expect(index.count()).toBe(2);
    expect((await index.search("apple", 5)).map((h) => h.id)).toEqual(["a"]);
  });
});

/** The textbook formula on arrays, with no inverted index: what the index has to agree with. */
function reference(
  texts: Map<string, string>,
  query: string,
  k1: number,
  b: number,
): { id: string; score: number }[] {
  const docs = [...texts].map(([id, text]) => ({ id, terms: analyze(text) }));
  const average = docs.reduce((sum, d) => sum + d.terms.length, 0) / docs.length;
  const scores = docs.map(({ id, terms }) => {
    let score = 0;
    for (const term of new Set(analyze(query))) {
      const tf = terms.filter((t) => t === term).length;
      if (tf === 0) continue;
      const df = docs.filter((d) => d.terms.includes(term)).length;
      const idf = Math.log(1 + (docs.length - df + 0.5) / (df + 0.5));
      score += (idf * tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * terms.length) / average));
    }
    return { id, score };
  });
  return scores
    .filter((s) => s.score > 0)
    .sort((a, b2) => b2.score - a.score || (a.id < b2.id ? -1 : 1));
}

describe("Bm25Index: against the textbook formula", () => {
  it("agrees on 120 random chunks and 25 random queries", async () => {
    let state = 7;
    const random = (): number => {
      state = (state * 1664525 + 1013904223) % 4294967296;
      return state / 4294967296;
    };
    const vocabulary = Array.from({ length: 30 }, (_, i) => `word${i.toString()}`);
    // a skewed choice, so some words are common and some rare
    const word = (): string => vocabulary[Math.floor(random() ** 2 * vocabulary.length)] ?? "";
    const texts = new Map<string, string>();
    for (let i = 0; i < 120; i++) {
      const length = 1 + Math.floor(random() * 25);
      texts.set(`c${i.toString().padStart(3, "0")}`, Array.from({ length }, word).join(" "));
    }
    const index = new Bm25Index();
    index.add([...texts].map(([id, text]) => chunk(id, text)));

    for (let q = 0; q < 25; q++) {
      const query = Array.from({ length: 1 + Math.floor(random() * 4) }, word).join(" ");
      const everything = reference(texts, query, 1.2, 0.75);
      const expected = everything.slice(0, 10);
      const actual = await index.search(query, 10);
      expect(actual).toHaveLength(expected.length);
      actual.forEach((hit, i) => {
        const want = expected[i];
        expect(hit.score).toBeCloseTo(want?.score ?? 0, 9);
        // the same chunk, unless two chunks tie to rounding, when either may come first
        if (hit.id !== want?.id) {
          expect(everything.find((e) => e.id === hit.id)?.score).toBeCloseTo(want?.score ?? 0, 9);
        }
      });
    }
  });
});

describe("Bm25Index: serialize and deserialize", () => {
  it("brings back an index that answers every query identically, settings included", async () => {
    const original = new Bm25Index({ k1: 2, b: 0.4, stopwords: ["the"] });
    original.add([
      chunk("d1", "the apple banana apple", meta({ sectionPath: ["Chapter 1"] })),
      chunk("d2", "banana cherry", meta({ pageStart: 4, pageEnd: 5 })),
      chunk("d3", "cherry cherry cherry date"),
    ]);
    const restored = Bm25Index.deserialize(original.serialize());

    expect(restored.count()).toBe(3);
    expect([restored.k1, restored.b]).toEqual([2, 0.4]);
    for (const query of ["apple cherry", "banana", "the", "date apple", "zebra"]) {
      expect(await restored.search(query, 5)).toEqual(await original.search(query, 5));
    }
    const filter: MetadataFilter = [{ kind: "pageRange", from: 4 }];
    expect(await restored.search("banana", 5, filter)).toEqual(
      await original.search("banana", 5, filter),
    );
    expect(restored.serialize()).toBe(original.serialize());
  });

  it("serializes the same index to the same text, whatever the order of insertion of terms", () => {
    const a = new Bm25Index();
    a.add([chunk("x", "pear apple"), chunk("y", "apple")]);
    const b = new Bm25Index();
    b.add([chunk("x", "apple pear"), chunk("y", "apple")]);
    expect(a.serialize()).toBe(b.serialize());
  });

  it("saves and loads an empty index", async () => {
    const restored = Bm25Index.deserialize(new Bm25Index().serialize());
    expect(restored.count()).toBe(0);
    expect(await restored.search("apple", 3)).toEqual([]);
  });

  it("accepts terms that are also names on every object", async () => {
    const index = new Bm25Index();
    index.add([chunk("a", "constructor prototype hasownproperty tostring")]);
    const restored = Bm25Index.deserialize(index.serialize());
    expect((await restored.search("constructor", 1)).map((h) => h.id)).toEqual(["a"]);
    expect(await restored.search("valueof", 1)).toEqual([]);
  });
});

describe("Bm25Index.deserialize: damaged text", () => {
  const good = (): Record<string, unknown> =>
    JSON.parse(handExample().serialize()) as Record<string, unknown>;
  const corrupt = (mutate: (json: Record<string, unknown>) => void): string | undefined => {
    const json = good();
    mutate(json);
    try {
      Bm25Index.deserialize(JSON.stringify(json));
    } catch (error) {
      return error instanceof RagError ? `${error.code}: ${error.message}` : "not a RagError";
    }
    return undefined;
  };
  type Terms = [string, number[]][];

  it("rejects text that is not JSON", () => {
    expect(() => Bm25Index.deserialize("{ nope")).toThrow(/INDEX_CORRUPT|not valid JSON/);
    expect(() => Bm25Index.deserialize("")).toThrow(RagError);
  });

  it("rejects a format version it does not know, naming it", () => {
    expect(corrupt((j) => (j["formatVersion"] = 9))).toMatch(/INDEX_CORRUPT.*version 9/);
  });

  it("rejects the wrong shape", () => {
    expect(corrupt((j) => delete j["docs"])).toMatch(/INDEX_CORRUPT.*unexpected shape/);
    expect(corrupt((j) => (j["b"] = 7))).toMatch(/INDEX_CORRUPT/);
    expect(corrupt((j) => (j["extra"] = 1))).toMatch(/INDEX_CORRUPT/);
  });

  it("rejects a term that points at a chunk that does not exist", () => {
    expect(corrupt((j) => ((j["terms"] as Terms)[0] = ["apple", [99, 1]]))).toMatch(
      /INDEX_CORRUPT.*does not exist/,
    );
  });

  it("rejects a term list that is not pairs, or has a zero count", () => {
    expect(corrupt((j) => ((j["terms"] as Terms)[0] = ["apple", [0]]))).toMatch(/pairs/);
    expect(corrupt((j) => ((j["terms"] as Terms)[0] = ["apple", [0, 0]]))).toMatch(/INDEX_CORRUPT/);
  });

  it("rejects a chunk whose length is not the sum of its term counts", () => {
    expect(
      corrupt((j) => {
        (j["docs"] as { length: number }[]).forEach((d) => {
          d.length = 50;
        });
      }),
    ).toMatch(/INDEX_CORRUPT.*add up/);
  });

  it("rejects a term listed twice and a chunk id listed twice", () => {
    expect(corrupt((j) => (j["terms"] as Terms).push(["apple", [0, 2]]))).toMatch(/twice/);
    expect(
      corrupt((j) => {
        (j["docs"] as { id: string }[]).forEach((d) => {
          d.id = "d1";
        });
      }),
    ).toMatch(/twice/);
  });
});

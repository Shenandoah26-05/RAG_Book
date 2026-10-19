import { describe, expect, it } from "vitest";
import type {
  Chunk,
  ChunkId,
  DocId,
  EmbedKind,
  Embedder,
  RetrievedChunk,
} from "../../core/index.js";
import { RagError } from "../../shared/index.js";
import { MmrDiversifier } from "./mmr-diversifier.js";

const unit = (...v: number[]): Float32Array => {
  const length = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return Float32Array.from(v.map((x) => x / length));
};

/** Gives each known text a chosen vector, and remembers what it was asked. */
function fakeEmbedder(vectors: Record<string, Float32Array>): Embedder & {
  calls: { texts: readonly string[]; kind: EmbedKind }[];
} {
  const calls: { texts: readonly string[]; kind: EmbedKind }[] = [];
  return {
    modelId: "fake:model",
    dimensions: 3,
    calls,
    embed: (texts, kind) => {
      calls.push({ texts: [...texts], kind });
      return Promise.resolve(texts.map((t) => vectors[t] ?? unit(1, 1, 1)));
    },
  };
}

function hit(
  id: string,
  text: string,
  score: number,
  rank: number,
  extra: Partial<Chunk> = {},
): RetrievedChunk {
  return {
    chunk: {
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
      ...extra,
    },
    score,
    rank,
    retriever: "dense",
  };
}

/**
 * Three near-copies about cats, one chunk about dogs, one about fish. The retriever liked the copies
 * best, as it would for a question about pets that the book answers three times.
 * Scaled relevance: (score - 0.55) / 0.40 = 1, 0.95, 0.90, 0.125, 0.
 */
const VECTORS = {
  "cats one": unit(1, 0, 0),
  "cats two": unit(0.99, 0.14, 0),
  "cats three": unit(0.98, 0.2, 0),
  dogs: unit(0, 1, 0),
  fish: unit(0, 0, 1),
};
const candidates = (): RetrievedChunk[] => [
  hit("cats1", "cats one", 0.95, 1),
  hit("cats2", "cats two", 0.93, 2),
  hit("cats3", "cats three", 0.91, 3),
  hit("dogs", "dogs", 0.6, 4),
  hit("fish", "fish", 0.55, 5),
];
const ids = (results: readonly RetrievedChunk[]): string[] => results.map((r) => r.chunk.id);

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return error instanceof RagError ? error.code : "not a RagError";
  }
  return undefined;
}

describe("MmrDiversifier: duplicated chunks", () => {
  it("with lambda 1 the three copies fill the result, exactly as ranked", async () => {
    const mmr = new MmrDiversifier({ embedder: fakeEmbedder(VECTORS), lambda: 1 });
    expect(ids(await mmr.diversify(candidates(), 3))).toEqual(["cats1", "cats2", "cats3"]);
  });

  it("with lambda 0.5 one copy is kept and the different chunks take the other places", async () => {
    // pick 1: cats1. pick 2: cats2: 0.5*0.95 - 0.5*0.99 = -0.02, cats3: 0.45 - 0.49 = -0.04,
    // dogs: 0.5*0.125 - 0 = 0.0625, fish: 0. -> dogs. pick 3: cats2 still -0.02, fish 0 -> fish.
    const mmr = new MmrDiversifier({ embedder: fakeEmbedder(VECTORS), lambda: 0.5 });
    expect(ids(await mmr.diversify(candidates(), 3))).toEqual(["cats1", "dogs", "fish"]);
  });

  it("uses 0.5 when no lambda is given, and a milder 0.7 lets the copies back in", async () => {
    const byDefault = new MmrDiversifier({ embedder: fakeEmbedder(VECTORS) });
    expect(byDefault.lambda).toBe(0.5);
    expect(ids(await byDefault.diversify(candidates(), 3))).toEqual(["cats1", "dogs", "fish"]);
    // at 0.7, pick 2: cats2 = 0.7*0.95 - 0.3*0.99 = 0.368 beats dogs = 0.7*0.125 = 0.0875
    const mild = new MmrDiversifier({ embedder: fakeEmbedder(VECTORS), lambda: 0.7 });
    expect(ids(await mild.diversify(candidates(), 2))).toEqual(["cats1", "cats2"]);
  });

  it("with lambda 0 the first chunk is the best and then variety only", async () => {
    const mmr = new MmrDiversifier({ embedder: fakeEmbedder(VECTORS), lambda: 0 });
    const result = ids(await mmr.diversify(candidates(), 3));
    expect(result[0]).toBe("cats1");
    expect(result.slice(1).sort()).toEqual(["dogs", "fish"]);
  });
});

describe("MmrDiversifier: what comes back", () => {
  it("renumbers ranks from 1 and keeps chunk, score and retriever as they were", async () => {
    const mmr = new MmrDiversifier({ embedder: fakeEmbedder(VECTORS), lambda: 0.5 });
    const input = candidates();
    const result = await mmr.diversify(input, 3);
    expect(result.map((r) => r.rank)).toEqual([1, 2, 3]);
    for (const r of result) {
      const original = input.find((c) => c.chunk.id === r.chunk.id);
      expect(r.chunk).toBe(original?.chunk);
      expect(r.score).toBe(original?.score);
      expect(r.retriever).toBe("dense");
    }
    // the input is left alone
    expect(input.map((c) => c.rank)).toEqual([1, 2, 3, 4, 5]);
  });

  it("returns every candidate when k is larger than the list", async () => {
    const mmr = new MmrDiversifier({ embedder: fakeEmbedder(VECTORS), lambda: 0.5 });
    const result = await mmr.diversify(candidates(), 50);
    expect(result).toHaveLength(5);
    expect(new Set(ids(result)).size).toBe(5);
  });

  it("gives the same result twice", async () => {
    const mmr = new MmrDiversifier({ embedder: fakeEmbedder(VECTORS), lambda: 0.5 });
    expect(await mmr.diversify(candidates(), 4)).toEqual(await mmr.diversify(candidates(), 4));
  });

  it("works on a single candidate and on equal scores", async () => {
    const mmr = new MmrDiversifier({ embedder: fakeEmbedder(VECTORS), lambda: 0.5 });
    expect(ids(await mmr.diversify([hit("a", "dogs", 3, 1)], 5))).toEqual(["a"]);
    const equal = [hit("a", "dogs", 1, 1), hit("b", "fish", 1, 2)];
    expect(ids(await mmr.diversify(equal, 2))).toEqual(["a", "b"]);
  });

  it("counts opposite vectors as unrelated, not as a reason to prefer a chunk", async () => {
    const opposite = { up: unit(0, 1, 0), down: unit(0, -1, 0), side: unit(1, 0, 0) };
    const mmr = new MmrDiversifier({ embedder: fakeEmbedder(opposite), lambda: 0.5 });
    // "down" is the opposite of "up" (cosine -1); "side" is unrelated (0). Both are penalty 0, so the
    // better-scored one comes first. With -1 left in, "down" would get a bonus and win.
    const input = [hit("up", "up", 1, 1), hit("side", "side", 0.5, 2), hit("down", "down", 0.9, 3)];
    expect(ids(await mmr.diversify(input, 3))).toEqual(["up", "down", "side"]);
  });
});

describe("MmrDiversifier: the embedder", () => {
  it("embeds the candidates once, as documents, using embedText when a chunk has one", async () => {
    const embedder = fakeEmbedder(VECTORS);
    const mmr = new MmrDiversifier({ embedder });
    await mmr.diversify(
      [hit("a", "dogs", 2, 1, { embedText: "Chapter 1 > dogs" }), hit("b", "fish", 1, 2)],
      2,
    );
    expect(embedder.calls).toEqual([{ texts: ["Chapter 1 > dogs", "fish"], kind: "document" }]);
  });

  it("does not embed anything for no candidates", async () => {
    const embedder = fakeEmbedder(VECTORS);
    expect(await new MmrDiversifier({ embedder }).diversify([], 3)).toEqual([]);
    expect(embedder.calls).toEqual([]);
  });

  it("reports an embedder that returns the wrong number of vectors", async () => {
    const broken: Embedder = { modelId: "x", dimensions: 3, embed: () => Promise.resolve([]) };
    const mmr = new MmrDiversifier({ embedder: broken });
    expect(await codeOf(mmr.diversify(candidates(), 2))).toBe("INTERNAL");
  });
});

describe("MmrDiversifier: invalid arguments", () => {
  it("rejects a lambda outside 0 to 1", () => {
    for (const lambda of [-0.1, 1.2, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new MmrDiversifier({ embedder: fakeEmbedder(VECTORS), lambda })).toThrow(
        /lambda must be/,
      );
    }
  });

  it("rejects k that is not a whole number of 1 or more", async () => {
    const mmr = new MmrDiversifier({ embedder: fakeEmbedder(VECTORS) });
    for (const k of [0, -1, 2.5, Number.NaN]) {
      expect(await codeOf(mmr.diversify(candidates(), k))).toBe("INVALID_ARGUMENT");
    }
  });

  it("rejects a chunk that appears twice, before embedding anything", async () => {
    const embedder = fakeEmbedder(VECTORS);
    const mmr = new MmrDiversifier({ embedder });
    const twice = [hit("a", "dogs", 2, 1), hit("a", "dogs", 1, 2)];
    expect(await codeOf(mmr.diversify(twice, 2))).toBe("INVALID_ARGUMENT");
    expect(embedder.calls).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import type { EmbedKind, Embedder } from "../../core/index.js";
import type { LogFields, Logger } from "../../shared/index.js";
import { describeEmbedderContract } from "../../testing/embedder-contract.testing.js";
import { CachingEmbedder, embeddingCacheKey } from "./caching-embedder.js";
import type { EmbeddingCache } from "./caching-embedder.js";

const DIMENSIONS = 4;

/** A repeatable, unit-length vector for a text. */
function fakeVector(text: string, salt = 0): Float32Array {
  const raw = Array.from(
    { length: DIMENSIONS },
    (_, i) => ((text.charCodeAt(i % text.length) + i + salt) % 17) + 1,
  );
  const length = Math.hypot(...raw);
  return Float32Array.from(raw.map((x) => x / length));
}

/** Records every call, so tests can see exactly what reached the model. */
class CountingEmbedder implements Embedder {
  readonly calls: { texts: readonly string[]; kind: EmbedKind }[] = [];
  constructor(readonly modelId = "fake:model") {}
  readonly dimensions = DIMENSIONS;

  embed(texts: readonly string[], kind: EmbedKind): Promise<readonly Float32Array[]> {
    this.calls.push({ texts, kind });
    return Promise.resolve(texts.map((text) => fakeVector(text)));
  }
}

class MemoryCache implements EmbeddingCache {
  readonly entries = new Map<string, Float32Array>();
  get(key: string): Promise<Float32Array | undefined> {
    return Promise.resolve(this.entries.get(key));
  }
  set(key: string, vector: Float32Array): Promise<void> {
    this.entries.set(key, vector);
    return Promise.resolve();
  }
}

function recordingLogger(): { logger: Logger; records: { message: string; fields?: LogFields }[] } {
  const records: { message: string; fields?: LogFields }[] = [];
  const log = (message: string, fields?: LogFields): void => {
    records.push(fields === undefined ? { message } : { message, fields });
  };
  const logger: Logger = { debug: log, info: log, warn: log, error: log, child: () => logger };
  return { logger, records };
}

const setup = () => {
  const inner = new CountingEmbedder();
  const cache = new MemoryCache();
  const { logger, records } = recordingLogger();
  return { inner, cache, records, embedder: new CachingEmbedder(inner, cache, logger) };
};

describeEmbedderContract("CachingEmbedder", () => setup().embedder);

describe("CachingEmbedder: caching", () => {
  it("makes zero model calls for texts it has already embedded", async () => {
    const { inner, embedder } = setup();
    const first = await embedder.embed(["a", "b", "c"], "document");
    const second = await embedder.embed(["a", "b", "c"], "document");

    expect(inner.calls).toHaveLength(1);
    expect(second).toEqual(first);
  });

  it("sends only the texts it has not seen, in one call, and keeps the order", async () => {
    const { inner, embedder } = setup();
    await embedder.embed(["b"], "document");
    const vectors = await embedder.embed(["a", "b", "c"], "document");

    expect(inner.calls[1]?.texts).toEqual(["a", "c"]);
    expect(vectors).toEqual([fakeVector("a"), fakeVector("b"), fakeVector("c")]);
  });

  it("embeds a text that appears twice in one call once", async () => {
    const { inner, embedder } = setup();
    const vectors = await embedder.embed(["a", "b", "a"], "query");

    expect(inner.calls[0]?.texts).toEqual(["a", "b"]);
    expect(vectors).toEqual([fakeVector("a"), fakeVector("b"), fakeVector("a")]);
  });

  it("keeps queries and documents apart", async () => {
    const { inner, embedder } = setup();
    await embedder.embed(["a"], "query");
    await embedder.embed(["a"], "document");
    expect(inner.calls.map((c) => c.kind)).toEqual(["query", "document"]);
  });

  it("keeps models apart", async () => {
    const cache = new MemoryCache();
    const one = new CountingEmbedder("fake:one");
    const two = new CountingEmbedder("fake:two");
    await new CachingEmbedder(one, cache).embed(["a"], "document");
    await new CachingEmbedder(two, cache).embed(["a"], "document");
    expect(two.calls).toHaveLength(1);
  });

  it("makes no model call and no cache lookup for an empty list", async () => {
    const { inner, embedder, records } = setup();
    expect(await embedder.embed([], "document")).toEqual([]);
    expect(inner.calls).toEqual([]);
    expect(records).toEqual([]);
  });

  it("passes the model id and dimensions of the wrapped embedder through", () => {
    const { embedder } = setup();
    expect(embedder.modelId).toBe("fake:model");
    expect(embedder.dimensions).toBe(DIMENSIONS);
  });
});

describe("CachingEmbedder: logging", () => {
  it("logs the hit and miss counts of each call", async () => {
    const { embedder, records } = setup();
    await embedder.embed(["a", "b"], "document");
    await embedder.embed(["a", "b", "c"], "document");

    expect(records.map((r) => r.fields)).toEqual([
      { model: "fake:model", kind: "document", hits: 0, misses: 2 },
      { model: "fake:model", kind: "document", hits: 2, misses: 1 },
    ]);
  });
});

describe("CachingEmbedder: a damaged or unavailable cache", () => {
  it("replaces a cached vector of the wrong length", async () => {
    const { inner, cache, embedder } = setup();
    cache.entries.set(embeddingCacheKey("fake:model", "document", "a"), new Float32Array(2));

    expect(await embedder.embed(["a"], "document")).toEqual([fakeVector("a")]);
    expect(inner.calls).toHaveLength(1);
    expect(cache.entries.get(embeddingCacheKey("fake:model", "document", "a"))).toHaveLength(
      DIMENSIONS,
    );
  });

  it("still answers, and warns, when the cache cannot be read or written", async () => {
    const inner = new CountingEmbedder();
    const broken: EmbeddingCache = {
      get: () => Promise.reject(new Error("disk gone")),
      set: () => Promise.reject(new Error("disk full")),
    };
    const { logger, records } = recordingLogger();
    const embedder = new CachingEmbedder(inner, broken, logger);

    expect(await embedder.embed(["a"], "document")).toEqual([fakeVector("a")]);
    expect(records.map((r) => r.message)).toEqual([
      "embedding cache read failed",
      "embedding cache write failed",
      "embedding cache",
    ]);
  });

  it("fails clearly if the wrapped embedder returns the wrong number of vectors", async () => {
    const inner: Embedder = {
      modelId: "fake:short",
      dimensions: DIMENSIONS,
      embed: () => Promise.resolve([]),
    };
    await expect(
      new CachingEmbedder(inner, new MemoryCache()).embed(["a"], "document"),
    ).rejects.toMatchObject({ code: "INTERNAL" });
  });

  it("does not let a failing wrapped embedder cache anything", async () => {
    const cache = new MemoryCache();
    const inner: Embedder = {
      modelId: "fake:down",
      dimensions: DIMENSIONS,
      embed: () => Promise.reject(new Error("server down")),
    };
    await expect(new CachingEmbedder(inner, cache).embed(["a"], "document")).rejects.toThrow(
      "server down",
    );
    expect(cache.entries.size).toBe(0);
  });
});

describe("embeddingCacheKey", () => {
  it("is a SHA-256 hex string", () => {
    expect(embeddingCacheKey("m", "query", "t")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("differs when only the boundary between model and text moves", () => {
    expect(embeddingCacheKey("ab", "query", "c")).not.toBe(embeddingCacheKey("a", "query", "bc"));
  });

  it("differs by kind and by text, and is stable", () => {
    const key = embeddingCacheKey("m", "query", "t");
    expect(embeddingCacheKey("m", "document", "t")).not.toBe(key);
    expect(embeddingCacheKey("m", "query", "u")).not.toBe(key);
    expect(embeddingCacheKey("m", "query", "t")).toBe(key);
  });
});

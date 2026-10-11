import type { EmbedKind, Embedder } from "../../core/index.js";
import { contentHash } from "../../core/index.js";
import { noopLogger, RagError } from "../../shared/index.js";
import type { Logger } from "../../shared/index.js";

/** Where finished vectors are kept, by key. The decorator does not care how. */
export interface EmbeddingCache {
  /** The vector stored under `key`, or undefined if there is none. */
  get(key: string): Promise<Float32Array | undefined>;
  set(key: string, vector: Float32Array): Promise<void>;
}

/**
 * The key of one cached vector: SHA-256 of the model, the kind and the text. The parts are
 * length-prefixed by `contentHash`, so ("ab", "c") and ("a", "bc") give different keys. Changing the
 * model or the kind (query vs document) can never return another model's vector.
 */
export function embeddingCacheKey(modelId: string, kind: EmbedKind, text: string): string {
  return contentHash("embedding", modelId, kind, text);
}

/**
 * Never embeds the same text with the same model twice. It wraps any `Embedder` and answers from
 * the cache when it can; only the texts it has not seen go to the wrapped embedder, in one call.
 * The wrapped embedder does not know it is cached, and callers see an ordinary `Embedder`.
 *
 * The cache is an optimisation, not a source of truth: a cache that cannot be read or written is
 * logged and skipped, and a cached vector of the wrong length is treated as missing and replaced.
 */
export class CachingEmbedder implements Embedder {
  readonly #inner: Embedder;
  readonly #cache: EmbeddingCache;
  readonly #logger: Logger;

  constructor(inner: Embedder, cache: EmbeddingCache, logger: Logger = noopLogger) {
    this.#inner = inner;
    this.#cache = cache;
    this.#logger = logger;
  }

  get modelId(): string {
    return this.#inner.modelId;
  }

  get dimensions(): number {
    return this.#inner.dimensions;
  }

  async embed(texts: readonly string[], kind: EmbedKind): Promise<readonly Float32Array[]> {
    if (texts.length === 0) {
      return [];
    }

    // One entry per distinct text: a text that appears twice is looked up and embedded once.
    const found = new Map<string, Float32Array | undefined>();
    for (const text of texts) {
      found.set(text, undefined);
    }
    await Promise.all(
      [...found.keys()].map(async (text) => {
        found.set(text, await this.#lookup(embeddingCacheKey(this.modelId, kind, text)));
      }),
    );

    const missing = [...found].filter(([, vector]) => vector === undefined).map(([text]) => text);
    if (missing.length > 0) {
      const vectors = await this.#inner.embed(missing, kind);
      if (vectors.length !== missing.length) {
        throw new RagError(
          "INTERNAL",
          `${this.modelId} returned ${vectors.length.toString()} vectors for ${missing.length.toString()} texts`,
        );
      }
      await Promise.all(
        missing.map(async (text, index) => {
          const vector = vectors[index] as Float32Array;
          found.set(text, vector);
          await this.#store(embeddingCacheKey(this.modelId, kind, text), vector);
        }),
      );
    }

    this.#logger.info("embedding cache", {
      model: this.modelId,
      kind,
      hits: texts.length - missing.length,
      misses: missing.length,
    });
    return texts.map((text) => found.get(text) as Float32Array);
  }

  async #lookup(key: string): Promise<Float32Array | undefined> {
    try {
      const vector = await this.#cache.get(key);
      return vector?.length === this.dimensions ? vector : undefined;
    } catch (error) {
      this.#logger.warn("embedding cache read failed", { key, error: String(error) });
      return undefined;
    }
  }

  async #store(key: string, vector: Float32Array): Promise<void> {
    try {
      await this.#cache.set(key, vector);
    } catch (error) {
      this.#logger.warn("embedding cache write failed", { key, error: String(error) });
    }
  }
}

import type { EmbedKind, Embedder } from "../../core/index.js";

export interface EmbedPrefixes {
  /** Put in front of a search question. */
  readonly query: string;
  /** Put in front of a passage that is being indexed. */
  readonly document: string;
}

/**
 * Makes an asymmetric embedding model work. Some models were trained to see a marker in front of
 * the text ("search_query: ...", "search_document: ..."); without it the vectors still come out,
 * but retrieval gets worse without any error. This decorator adds the marker that matches `kind`,
 * so callers keep passing plain text and the wrapped embedder does not know about prefixes.
 *
 * Put it **outside** a `CachingEmbedder`: the cache then keys on the text that was really embedded,
 * so changing a prefix can never return a vector made with the old one.
 */
export class PrefixingEmbedder implements Embedder {
  readonly #inner: Embedder;
  readonly #prefixes: EmbedPrefixes;

  constructor(inner: Embedder, prefixes: EmbedPrefixes) {
    this.#inner = inner;
    this.#prefixes = prefixes;
  }

  get modelId(): string {
    return this.#inner.modelId;
  }

  get dimensions(): number {
    return this.#inner.dimensions;
  }

  embed(texts: readonly string[], kind: EmbedKind): Promise<readonly Float32Array[]> {
    const prefix = this.#prefixes[kind];
    return this.#inner.embed(prefix === "" ? texts : texts.map((text) => prefix + text), kind);
  }
}

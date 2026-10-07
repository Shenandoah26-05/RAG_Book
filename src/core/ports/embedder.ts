/**
 * What the text is for. Some models expect a different prefix for a search query than for a passage
 * (asymmetric models); models that do not care ignore it.
 */
export type EmbedKind = "query" | "document";

/** Turns text into vectors. Every embedding model implements this. */
export interface Embedder {
  /** Identifies the model, e.g. "ollama:all-minilm". Part of any cache key. */
  readonly modelId: string;
  /** Length of every vector this embedder returns. */
  readonly dimensions: number;
  /**
   * Embeds `texts` and returns one vector per text, in the same order.
   * Vectors are **L2-normalised** (length 1), so the dot product of two vectors is their cosine
   * similarity. An empty input gives an empty result.
   */
  embed(texts: readonly string[], kind: EmbedKind): Promise<readonly Float32Array[]>;
}

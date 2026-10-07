/** Where the topic shifts, decided from the similarity of each pair of neighbouring sentences. */
export type BreakRule =
  /** Break where the similarity is below this value (cosine similarity, -1 to 1). */
  | { readonly kind: "threshold"; readonly value: number }
  /** Break at the lowest `value` percent of similarities in the document (0 to 100). */
  | { readonly kind: "percentile"; readonly value: number };

/** Cosine similarity of two vectors. 0 when either has no length, so it never returns NaN. */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  return normA === 0 || normB === 0 ? 0 : dot / Math.sqrt(normA * normB);
}

/** Similarity of each sentence with the next one: `n` vectors give `n - 1` values. */
export function neighbourSimilarities(vectors: readonly Float32Array[]): number[] {
  const result: number[] = [];
  for (let i = 1; i < vectors.length; i++) {
    const previous = vectors[i - 1];
    const current = vectors[i];
    if (previous !== undefined && current !== undefined) {
      result.push(cosineSimilarity(previous, current));
    }
  }
  return result;
}

/** The value below which `percent` percent of `values` fall (linear interpolation). */
export function percentile(values: readonly number[], percent: number): number {
  if (values.length === 0) return Number.NEGATIVE_INFINITY;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (Math.min(Math.max(percent, 0), 100) / 100) * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const low = sorted[lower] ?? 0;
  const high = sorted[upper] ?? low;
  return low + (high - low) * (position - lower);
}

/**
 * Which gaps are topic shifts. Entry `i` of the result is true when there should be a break
 * between sentence `i` and sentence `i + 1`. Pure: no embedder, no document.
 */
export function findBreakpoints(similarities: readonly number[], rule: BreakRule): boolean[] {
  const limit = rule.kind === "threshold" ? rule.value : percentile(similarities, rule.value);
  // With a percentile rule, "below" would break nothing when the limit equals the lowest value, so
  // percentile 0 means "no breaks" and any higher percentile includes the values at the limit.
  if (rule.kind === "percentile") {
    return rule.value <= 0 ? similarities.map(() => false) : similarities.map((s) => s <= limit);
  }
  return similarities.map((similarity) => similarity < limit);
}

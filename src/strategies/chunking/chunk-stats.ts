import type { Chunk } from "../../core/index.js";
import { RagError } from "../../shared/index.js";
import type { TokenCounter } from "./recursive-split.js";

/** The chunks whose size is in `[from, to)`. */
export interface HistogramBucket {
  readonly from: number;
  readonly to: number;
  readonly count: number;
}

export interface ChunkStats {
  readonly count: number;
  /** Token size of each chunk's `text`, in document order. */
  readonly sizes: readonly number[];
  readonly min: number;
  readonly max: number;
  readonly mean: number;
  readonly median: number;
  /** Equal-width buckets from the smallest to the biggest chunk. Empty when there are no chunks. */
  readonly histogram: readonly HistogramBucket[];
}

export const DEFAULT_BUCKETS = 8;

/**
 * Counts the chunks and measures their size in tokens, to see what a strategy produced. Sizes are
 * those of `chunk.text` (what is shown and sent to the LLM), not `embedText`.
 *
 * @param bucketCount most buckets in the histogram. Fewer are used when the sizes are close
 *   together, so a bucket is never narrower than one token.
 * @throws RagError INVALID_ARGUMENT if `bucketCount` is not a whole number of 1 or more
 */
export function summarizeChunks(
  chunks: readonly Chunk[],
  countTokens: TokenCounter,
  bucketCount = DEFAULT_BUCKETS,
): ChunkStats {
  if (!Number.isInteger(bucketCount) || bucketCount < 1) {
    throw new RagError(
      "INVALID_ARGUMENT",
      `bucketCount must be a whole number of 1 or more, got ${String(bucketCount)}`,
    );
  }
  const sizes = chunks.map((chunk) => countTokens(chunk.text));
  if (sizes.length === 0) {
    return { count: 0, sizes, min: 0, max: 0, mean: 0, median: 0, histogram: [] };
  }

  const sorted = [...sizes].sort((a, b) => a - b);
  const min = sorted[0] ?? 0;
  const max = sorted[sorted.length - 1] ?? 0;
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 1
      ? (sorted[middle] ?? 0)
      : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
  const mean = sizes.reduce((sum, size) => sum + size, 0) / sizes.length;

  const width = Math.max(1, Math.ceil((max - min + 1) / bucketCount));
  const buckets = Math.ceil((max - min + 1) / width);
  const counts = new Array<number>(buckets).fill(0);
  for (const size of sizes) {
    const index = Math.floor((size - min) / width);
    counts[index] = (counts[index] ?? 0) + 1;
  }
  const histogram = counts.map((count, index) => ({
    from: min + index * width,
    to: Math.min(min + (index + 1) * width, max + 1),
    count,
  }));

  return { count: sizes.length, sizes, min, max, mean, median, histogram };
}

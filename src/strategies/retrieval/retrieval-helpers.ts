import type { ChunkStore, RetrievedChunk, ScoredId } from "../../core/index.js";
import { RagError } from "../../shared/index.js";

/** Rejects what every retriever rejects: a `k` that is not a whole number of 1 or more, a blank question. */
export function assertValidRequest(k: number, questionText: string): void {
  if (!Number.isInteger(k) || k < 1) {
    throw new RagError(
      "INVALID_ARGUMENT",
      `k must be a whole number of 1 or more, got ${String(k)}`,
    );
  }
  if (questionText.trim() === "") {
    throw new RagError("INVALID_ARGUMENT", "The question is blank");
  }
}

/**
 * The id-to-chunk step: looks up the chunks of the hits and ranks them from 1. A hit without a
 * chunk means the index and the chunk store are out of step, which is an error, not a gap to skip.
 */
export async function resolveHits(
  hits: readonly ScoredId[],
  chunkStore: ChunkStore,
  retriever: string,
): Promise<readonly RetrievedChunk[]> {
  const chunks = await chunkStore.get(hits.map((hit) => hit.id));
  return hits.map((hit, index) => {
    const chunk = chunks[index];
    if (chunk === undefined) {
      throw new RagError(
        "INTERNAL",
        `The index found chunk ${hit.id} but the chunk store does not have it. ` +
          'The index is inconsistent: rebuild it with "pnpm index --force".',
      );
    }
    return { chunk, score: hit.score, rank: index + 1, retriever };
  });
}

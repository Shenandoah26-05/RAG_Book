import type { ChunkId, RankedList, ScoredId } from "../../core/index.js";
import { RagError } from "../../shared/index.js";

/** Rejects lists that break the `FusionStrategy` input rules (see core/ports/fusion.ts). */
export function assertValidLists(lists: readonly RankedList[]): void {
  const names = new Set<string>();
  for (const list of lists) {
    if (names.has(list.retriever)) {
      throw new RagError(
        "INVALID_ARGUMENT",
        `Two ranked lists are from "${list.retriever}"; each retriever may appear once`,
      );
    }
    names.add(list.retriever);
    const ids = new Set<ChunkId>();
    for (const hit of list.hits) {
      if (ids.has(hit.id)) {
        throw new RagError(
          "INVALID_ARGUMENT",
          `Chunk ${hit.id} appears twice in the list from "${list.retriever}"`,
        );
      }
      ids.add(hit.id);
    }
  }
}

/** Fused scores by id, as the result: best first, equal scores by id. */
export function rankScores(scores: ReadonlyMap<ChunkId, number>): readonly ScoredId[] {
  return [...scores]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

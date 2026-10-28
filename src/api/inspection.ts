import type { ChunkFate, WireCandidate, WireFoundBy, WireInspection } from "@rag-book/api-contract";
import type { AssembledPrompt, ChunkId, RetrievedChunk } from "../core/index.js";
import type { RetrievalReport } from "../pipeline/index.js";
import type { RetrieverCall } from "../shared/index.js";

/** How much of a chunk's text the inspector gets: enough to recognise the passage, not to read it. */
export const SNIPPET_CHARS = 240;

/** The text on one line, cut to `SNIPPET_CHARS`. */
export function snippetOf(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= SNIPPET_CHARS ? flat : `${flat.slice(0, SNIPPET_CHARS - 1)}…`;
}

/**
 * Which base retrievers found a chunk on their own, with their own rank and score, best rank first.
 * A parent chunk (parent-child strategy) was never found itself: its children were, so a retriever
 * that found a child counts. A retriever that searched twice (query variants) counts once, by its
 * best rank.
 */
function foundBy(chunk: RetrievedChunk["chunk"], calls: readonly RetrieverCall[]): WireFoundBy[] {
  const best = new Map<string, WireFoundBy>();
  for (const call of calls) {
    for (const hit of call.results) {
      if (hit.chunk.id !== chunk.id && hit.chunk.parentId !== chunk.id) continue;
      const known = best.get(call.name);
      if (known === undefined || hit.rank < known.rank) {
        best.set(call.name, { retriever: call.name, rank: hit.rank, score: hit.score });
      }
    }
  }
  return [...best.values()].sort((a, b) => a.rank - b.rank);
}

/**
 * The inspector's view of an answer: every chunk retrieval found, with who found it, where the
 * reranker moved it, and whether it reached the prompt (and if not, why), plus the prompt itself.
 * `answered` is false when the guardrails refused and the model was never called with the prompt.
 */
export function toWireInspection(
  retrieval: RetrievalReport,
  prompt: AssembledPrompt,
  answered: boolean,
): WireInspection {
  const finals = new Map<ChunkId, RetrievedChunk>(retrieval.ranked.map((r) => [r.chunk.id, r]));
  const dropped = new Map<ChunkId, ChunkFate>(
    prompt.dropped.map(({ chunk, reason }) => [chunk.chunk.id, reason]),
  );
  const sources = new Map<ChunkId, number>(prompt.included.map((r, i) => [r.chunk.id, i + 1]));

  const candidates = retrieval.candidates.map((candidate): WireCandidate => {
    const { chunk } = candidate;
    const final = finals.get(chunk.id);
    const source = sources.get(chunk.id);
    const fate: ChunkFate = source !== undefined ? "used" : (dropped.get(chunk.id) ?? "cut");
    return {
      chunkId: chunk.id,
      pageStart: chunk.metadata.pageStart,
      pageEnd: chunk.metadata.pageEnd,
      sectionPath: [...chunk.metadata.sectionPath],
      snippet: snippetOf(chunk.text),
      rank: candidate.rank,
      score: candidate.score,
      retriever: candidate.retriever,
      foundBy: foundBy(chunk, retrieval.retrievers),
      finalRank: final?.rank ?? null,
      finalScore: final?.score ?? null,
      fate,
      ...(source === undefined ? {} : { source }),
    };
  });

  return {
    candidates,
    prompt: {
      version: prompt.promptVersion,
      system: prompt.system,
      user: prompt.user,
      sourceTokens: prompt.sourceTokens,
      budget: prompt.budget,
      sent: answered,
    },
  };
}

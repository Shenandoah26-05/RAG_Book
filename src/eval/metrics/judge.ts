import type { CharSpan, DocId, ParsedDocument, RetrievedChunk } from "../../core/index.js";
import { RagError } from "../../shared/index.js";
import { resolveGold } from "../dataset/index.js";
import type { Question } from "../dataset/index.js";

/** A passage that holds the answer: where it sits in one document. */
export interface GoldPassage {
  readonly docId: DocId;
  /** Half-open character range in `ParsedDocument.text`, the same units chunk spans use. */
  readonly span: CharSpan;
}

/**
 * Whether two half-open ranges share at least one character. Ranges that only touch (one ends where
 * the other starts) do not overlap, and an empty range overlaps nothing.
 */
export function spansOverlap(a: CharSpan, b: CharSpan): boolean {
  return a.start < a.end && b.start < b.end && a.start < b.end && b.start < a.end;
}

/**
 * The gold passages of a question as character spans in `doc`, which must be the document the
 * dataset was written against.
 * @throws RagError INVALID_ARGUMENT if a quote cannot be found exactly once (run `pnpm eval:validate`)
 */
export function goldPassages(doc: ParsedDocument, question: Question): readonly GoldPassage[] {
  return question.gold.map((gold) => {
    const resolved = resolveGold(doc, gold);
    if (!resolved.ok) {
      throw new RagError(
        "INVALID_ARGUMENT",
        `Question ${question.id}: gold does not resolve: ${resolved.message}`,
      );
    }
    return { docId: doc.id, span: resolved.span };
  });
}

/**
 * What a ranked result list achieved against the gold passages. Built once per question by
 * `judgeRetrieval`; the metrics read it. Index `i` is rank `i + 1`.
 */
export interface RetrievalJudgement {
  /** How many gold passages the question has. At least 1. */
  readonly goldCount: number;
  /** Whether the chunk at this rank overlaps any gold passage. */
  readonly relevant: readonly boolean[];
  /**
   * Whether the chunk at this rank is the first to overlap some gold passage. A second chunk over
   * a passage that is already covered finds nothing new, so it is `false` here.
   */
  readonly newlyCovered: readonly boolean[];
}

/**
 * Compares a ranked list with the gold passages. A chunk counts only against passages of its own
 * document.
 * @throws RagError INVALID_ARGUMENT if there is no gold: an unanswerable question has nothing to find
 */
export function judgeRetrieval(
  retrieved: readonly Pick<RetrievedChunk, "chunk">[],
  gold: readonly GoldPassage[],
): RetrievalJudgement {
  if (gold.length === 0) {
    throw new RagError(
      "INVALID_ARGUMENT",
      "A question without gold passages has nothing to retrieve, so retrieval metrics do not apply. Leave unanswerable questions out.",
    );
  }
  const covered = new Set<number>();
  const relevant: boolean[] = [];
  const newlyCovered: boolean[] = [];
  for (const { chunk } of retrieved) {
    const span = { start: chunk.metadata.charStart, end: chunk.metadata.charEnd };
    let isRelevant = false;
    let isNew = false;
    gold.forEach((passage, index) => {
      if (passage.docId !== chunk.metadata.docId || !spansOverlap(span, passage.span)) return;
      isRelevant = true;
      if (!covered.has(index)) {
        covered.add(index);
        isNew = true;
      }
    });
    relevant.push(isRelevant);
    newlyCovered.push(isNew);
  }
  return { goldCount: gold.length, relevant, newlyCovered };
}

import type {
  QuestionResult,
  ResultProvenance,
  RetrievalScores,
  VariantSummary,
} from "../../core/index.js";

const mean = (values: readonly number[]): number =>
  values.reduce((sum, value) => sum + value, 0) / values.length;

/** Nearest-rank percentile: the smallest value that at least `p` of the values are at or below. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))] ?? 0;
}

/** What a variant is, before any question is asked. The rest of its summary comes from the results. */
export interface VariantFacts {
  readonly variant: string;
  readonly configHash: string;
  readonly settings: Readonly<Record<string, unknown>>;
  readonly configFile: string;
  readonly k: number;
  readonly models: ResultProvenance["models"];
  readonly index: VariantSummary["index"];
}

/**
 * Condenses one variant's question results. A question that failed is counted in `failed` and left
 * out of every mean, so one error does not pull a score towards zero. Retrieval means cover the
 * answerable questions only (an unanswerable question has nothing to find); generation means cover
 * the questions that were answered and judged.
 */
export function summarizeVariant(
  facts: VariantFacts,
  results: readonly QuestionResult[],
): VariantSummary {
  const ok = results.filter((r) => r.error === undefined);
  const answerable = results.filter((r) => r.kind !== "unanswerable");
  const scored = ok.filter(
    (r): r is QuestionResult & { retrieval: RetrievalScores } => r.retrieval !== undefined,
  );
  const judged = ok.filter((r) => r.generation !== undefined);
  const faithful = judged.flatMap((r) =>
    r.generation?.faithfulness === undefined ? [] : [r.generation.faithfulness],
  );
  const generationMs = ok.flatMap((r) =>
    r.latencyMs.generation === undefined ? [] : [r.latencyMs.generation],
  );
  const retrievalMs = ok.map((r) => r.latencyMs.retrieval);

  return {
    ...facts,
    questions: {
      total: results.length,
      answerable: answerable.length,
      unanswerable: results.length - answerable.length,
      failed: results.length - ok.length,
    },
    ...(scored.length === 0
      ? {}
      : {
          retrieval: {
            questions: scored.length,
            hit: mean(scored.map((r) => r.retrieval.hit)),
            precision: mean(scored.map((r) => r.retrieval.precision)),
            recall: mean(scored.map((r) => r.retrieval.recall)),
            mrr: mean(scored.map((r) => r.retrieval.mrr)),
            ndcg: mean(scored.map((r) => r.retrieval.ndcg)),
          },
        }),
    ...(judged.length === 0
      ? {}
      : {
          generation: {
            judged: judged.length,
            ...(faithful.length === 0 ? {} : { faithfulness: mean(faithful) }),
            relevance: mean(judged.map((r) => r.generation?.relevance ?? 0)),
            correctness: mean(judged.map((r) => r.generation?.correctness ?? 0)),
          },
        }),
    refusals: {
      unanswerableRefused: ok.filter((r) => r.kind === "unanswerable" && !r.answered).length,
      answerableRefused: ok.filter((r) => r.kind !== "unanswerable" && !r.answered).length,
    },
    latencyMs: {
      retrievalP50: percentile(retrievalMs, 0.5),
      retrievalP95: percentile(retrievalMs, 0.95),
      ...(generationMs.length === 0
        ? {}
        : {
            generationP50: percentile(generationMs, 0.5),
            generationP95: percentile(generationMs, 0.95),
          }),
    },
    tokens: {
      prompt: ok.reduce((sum, r) => sum + (r.tokens?.prompt ?? 0), 0),
      output: ok.reduce((sum, r) => sum + (r.tokens?.output ?? 0), 0),
    },
  };
}

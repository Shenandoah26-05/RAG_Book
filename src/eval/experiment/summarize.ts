import type {
  QuestionResult,
  ResultProvenance,
  ResultUsage,
  RetrievalScores,
  VariantCost,
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
  /** The currency of the price table, for the cost. */
  readonly currency?: string;
}

/**
 * Condenses one variant's question results. A question that failed is counted in `failed` and left
 * out of every mean, so one error does not pull a score towards zero. Retrieval means cover the
 * answerable questions only (an unanswerable question has nothing to find); generation means cover
 * the questions that were answered and judged.
 */
/** What the questions that ran cost: the system, and the judge apart. Undefined without any usage. */
function costOfResults(currency: string, ok: readonly QuestionResult[]): VariantCost | undefined {
  const used = ok.filter((r) => r.usage !== undefined);
  const judged = ok.filter((r) => r.judgeUsage !== undefined);
  if (used.length === 0 && judged.length === 0) return undefined;
  const sum = (
    pick: (u: ResultUsage) => number,
    from: readonly (ResultUsage | undefined)[],
  ): number => from.reduce((total, u) => total + (u === undefined ? 0 : pick(u)), 0);
  const system = used.map((r) => r.usage);
  const judge = judged.map((r) => r.judgeUsage);
  // per 100 questions of the ones that ran, so a question with no recorded call counts as free
  const per100 = (total: number): number => (ok.length === 0 ? 0 : (total / ok.length) * 100);
  const total = sum((u) => u.cost, system);
  const judgeTotal = sum((u) => u.cost, judge);
  return {
    currency,
    total,
    per100Questions: per100(total),
    calls: sum((u) => u.calls, system),
    promptTokens: sum((u) => u.promptTokens, system),
    outputTokens: sum((u) => u.outputTokens, system),
    embeddedTokens: sum((u) => u.embeddedTokens, system),
    modelMs: sum((u) => u.modelMs, system),
    unpricedTokens: sum((u) => u.unpricedTokens, system),
    ...(judged.length === 0
      ? {}
      : {
          judge: {
            total: judgeTotal,
            per100Questions: per100(judgeTotal),
            calls: sum((u) => u.calls, judge),
            promptTokens: sum((u) => u.promptTokens, judge),
            outputTokens: sum((u) => u.outputTokens, judge),
            unpricedTokens: sum((u) => u.unpricedTokens, judge),
          },
        }),
  };
}

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

  const { currency = "", ...rest } = facts;
  const cost = costOfResults(currency, ok);
  return {
    ...rest,
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
    ...(cost === undefined ? {} : { cost }),
  };
}

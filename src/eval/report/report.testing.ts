// Builders for the tests of the report. Not part of the build (see tsconfig.build.json).
import type { ExperimentSummary, QuestionResult } from "../../core/index.js";
import { summarizeVariant } from "../experiment/index.js";

export interface VariantSpec {
  /** nDCG per question, in question order. `undefined` makes the question unanswerable. */
  readonly ndcg: readonly (number | undefined)[];
  readonly k?: number;
  /** Correctness per question; present means answers were judged. */
  readonly correctness?: readonly (number | undefined)[];
  readonly retrievalMs?: number;
  readonly tokens?: { prompt: number; output: number };
  /** Question indexes (0-based) that failed. */
  readonly failed?: readonly number[];
  readonly settings?: Record<string, unknown>;
  readonly indexStatus?: "built" | "reused";
}

export const qid = (index: number): string => `q${(index + 1).toString().padStart(3, "0")}`;

function results(name: string, spec: VariantSpec): QuestionResult[] {
  return spec.ndcg.map((ndcg, index) => {
    const answerable = ndcg !== undefined;
    const correctness = spec.correctness?.[index];
    const failed = spec.failed?.includes(index) === true;
    return {
      experiment: "exp",
      variant: name,
      configHash: `hash-${name}`,
      gitCommit: "abcdef1234567",
      datasetVersion: "v1",
      models: { embedder: "ollama:embed", generator: "ollama:gen" },
      questionId: qid(index),
      kind: answerable ? "factual" : "unanswerable",
      k: spec.k ?? 5,
      retrieved: [],
      ...(answerable && !failed
        ? {
            retrieval: {
              hit: ndcg > 0 ? 1 : 0,
              precision: ndcg / 5,
              recall: ndcg,
              mrr: ndcg,
              ndcg,
            },
          }
        : {}),
      answered: answerable,
      ...(correctness === undefined
        ? {}
        : { generation: { relevance: 1, correctness, promptVersions: ["judge@v1"] } }),
      latencyMs: {
        retrieval: spec.retrievalMs ?? 10,
        ...(correctness === undefined ? {} : { generation: 100 }),
      },
      ...(spec.tokens === undefined ? {} : { tokens: spec.tokens }),
      ...(failed ? { error: "boom" } : {}),
    };
  });
}

/** A finished run of variants with the given scores: the results and the summary that matches them. */
export function makeRun(
  specs: Record<string, VariantSpec>,
  options: { readonly failedVariants?: Record<string, string>; readonly generation?: boolean } = {},
): { summary: ExperimentSummary; results: QuestionResult[] } {
  const all: QuestionResult[] = [];
  const variants = Object.entries(specs).map(([name, spec]) => {
    const own = results(name, spec);
    all.push(...own);
    return summarizeVariant(
      {
        variant: name,
        configHash: `hash-${name}`,
        settings: spec.settings ?? { name },
        configFile: `evals/results/exp/now/configs/${name}.json`,
        k: spec.k ?? 5,
        models: { embedder: "ollama:embed", generator: "ollama:gen" },
        index: { namespace: "recursive__ollama-embed", status: spec.indexStatus ?? "reused" },
      },
      own,
    );
  });
  for (const [name, error] of Object.entries(options.failedVariants ?? {})) {
    variants.push({
      variant: name,
      configHash: "",
      settings: {},
      configFile: "",
      k: 0,
      models: { embedder: "", generator: "" },
      index: { namespace: "", status: "reused" },
      questions: { total: 0, answerable: 0, unanswerable: 0, failed: 0 },
      refusals: { unanswerableRefused: 0, answerableRefused: 0 },
      latencyMs: { retrievalP50: 0, retrievalP95: 0 },
      tokens: { prompt: 0, output: 0 },
      error,
    });
  }
  return {
    results: all,
    summary: {
      experiment: "exp",
      description: "Compare things",
      dataset: "evals/datasets/v1.jsonl",
      datasetVersion: "v1",
      gitCommit: "abcdef1234567",
      startedAt: "2026-10-22T10:00:00.000Z",
      finishedAt: "2026-10-22T10:05:00.000Z",
      generation: options.generation ?? false,
      variants,
    },
  };
}

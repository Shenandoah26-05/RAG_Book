import type {
  AnswerJudge,
  ExperimentStore,
  ExperimentSummary,
  QuestionResult,
  ResultProvenance,
  RetrievedRecord,
  VariantSummary,
} from "../../core/index.js";
import { RagError, Trace, noopLogger, usageOf, withTrace } from "../../shared/index.js";
import type { Logger, PriceTable } from "../../shared/index.js";
import type { Question } from "../dataset/index.js";
import { judgeRetrieval, retrievalMetrics } from "../metrics/index.js";
import type { GoldPassage } from "../metrics/index.js";
import type { ExperimentVariant } from "./expand-variants.js";
import { NO_PRICES, resultUsage } from "./result-usage.js";
import type { Experiment } from "./schema.js";
import { summarizeVariant } from "./summarize.js";
import type { VariantFacts } from "./summarize.js";
import type { SystemAnswer, VariantFactory, VariantSystem } from "./system.js";

export interface RunExperimentDeps {
  readonly experiment: Pick<Experiment, "name" | "description" | "generation">;
  readonly variants: readonly ExperimentVariant[];
  readonly dataset: { readonly path: string; readonly version: string };
  readonly questions: readonly Question[];
  /** The gold passages of each answerable question, by question id. */
  readonly gold: ReadonlyMap<string, readonly GoldPassage[]>;
  readonly factory: VariantFactory;
  /** Required when the experiment generates answers. */
  readonly judge?: AnswerJudge;
  /** What the models cost, to put money on each question. Without it only tokens are reported. */
  readonly prices?: PriceTable;
  readonly store: ExperimentStore;
  /** The commit the code is at; recorded on every result. */
  readonly gitCommit: string | null;
  readonly now?: () => Date;
  /** Milliseconds from any fixed starting point; used to time the judge. */
  readonly clock?: () => number;
  readonly logger?: Logger;
  /** Aborting stops the run before the next question; the abort is rethrown. */
  readonly signal?: AbortSignal;
}

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Runs every variant of an experiment over the dataset and saves what happened.
 *
 *   for each variant:  prepare (config, index, pipeline) -> for each question: ask -> score -> save
 *
 * The runner knows nothing about chunkers, retrievers or models. A variant is something that can be
 * asked a question (`VariantSystem`); which strategies are inside is the factory's business, so a
 * new strategy needs no change here. Variants run one after another, and so do their questions:
 * the models run locally, and parallel requests would only distort the latency numbers.
 *
 * Failures are data, not crashes. A variant that cannot be built is recorded with its error and
 * the run goes on; a question that fails is saved with its error and left out of the means. A
 * result is written as soon as it exists, so a run that is stopped keeps what it finished.
 *
 * @throws RagError INVALID_ARGUMENT if answers are to be judged and no judge was given
 * @throws the signal's reason if the run is aborted
 */
export async function runExperiment(deps: RunExperimentDeps): Promise<ExperimentSummary> {
  const { experiment, variants, dataset, questions, store, signal } = deps;
  const logger = deps.logger ?? noopLogger;
  const now = deps.now ?? ((): Date => new Date());
  if (experiment.generation && deps.judge === undefined) {
    throw new RagError(
      "INVALID_ARGUMENT",
      "The experiment generates answers, so it needs a judge to score them",
    );
  }

  const startedAt = now().toISOString();
  const summaries: VariantSummary[] = [];

  for (const variant of variants) {
    signal?.throwIfAborted();
    logger.info("variant", { variant: variant.name });

    let system: VariantSystem;
    try {
      system = await deps.factory.prepare(variant, signal);
    } catch (error) {
      signal?.throwIfAborted();
      logger.error("variant could not be built", { variant: variant.name, error: message(error) });
      summaries.push(failedVariant(variant, message(error)));
      continue;
    }

    const provenance: ResultProvenance = {
      experiment: experiment.name,
      variant: variant.name,
      configHash: system.configHash,
      gitCommit: deps.gitCommit,
      datasetVersion: dataset.version,
      models: {
        ...system.models,
        ...(experiment.generation && deps.judge !== undefined ? { judge: deps.judge.modelId } : {}),
      },
    };

    const results: QuestionResult[] = [];
    for (const question of questions) {
      signal?.throwIfAborted();
      const result = await runQuestion(question, system, provenance, deps);
      await store.append(result);
      results.push(result);
    }

    const facts: VariantFacts = {
      variant: variant.name,
      configHash: system.configHash,
      settings: variant.settings,
      configFile: system.configFile,
      k: system.k,
      models: provenance.models,
      index: system.index,
      ...(deps.prices === undefined ? {} : { currency: deps.prices.currency }),
    };
    summaries.push(summarizeVariant(facts, results));
  }

  const summary: ExperimentSummary = {
    experiment: experiment.name,
    ...(experiment.description === undefined ? {} : { description: experiment.description }),
    dataset: dataset.path,
    datasetVersion: dataset.version,
    gitCommit: deps.gitCommit,
    startedAt,
    finishedAt: now().toISOString(),
    generation: experiment.generation,
    variants: summaries,
  };
  await store.finish(summary);
  return summary;
}

/** A variant that never ran: nothing to average, only the reason. */
function failedVariant(variant: ExperimentVariant, error: string): VariantSummary {
  return {
    variant: variant.name,
    configHash: "",
    settings: variant.settings,
    configFile: "",
    k: 0,
    models: { embedder: "", generator: "" },
    index: { namespace: "", status: "reused" },
    questions: { total: 0, answerable: 0, unanswerable: 0, failed: 0 },
    refusals: { unanswerableRefused: 0, answerableRefused: 0 },
    latencyMs: { retrievalP50: 0, retrievalP95: 0 },
    tokens: { prompt: 0, output: 0 },
    error,
  };
}

async function runQuestion(
  question: Question,
  system: VariantSystem,
  provenance: ResultProvenance,
  deps: RunExperimentDeps,
): Promise<QuestionResult> {
  const { signal } = deps;
  const clock = deps.clock ?? ((): number => performance.now());
  const generate = deps.experiment.generation;
  const base = { ...provenance, questionId: question.id, kind: question.kind, k: system.k };

  let answer: SystemAnswer;
  try {
    answer = await system.ask(question.question, {
      generate,
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    signal?.throwIfAborted();
    return {
      ...base,
      retrieved: [],
      answered: false,
      latencyMs: { retrieval: 0 },
      error: message(error),
    };
  }

  const retrieved = answer.retrieved.slice(0, system.k);
  const gold = deps.gold.get(question.id);
  const judgement =
    question.kind === "unanswerable" || gold === undefined || gold.length === 0
      ? undefined
      : judgeRetrieval(retrieved, gold);
  const records: RetrievedRecord[] = retrieved.map((r, index) => ({
    chunkId: r.chunk.id,
    rank: index + 1,
    score: r.score,
    pageStart: r.chunk.metadata.pageStart,
    pageEnd: r.chunk.metadata.pageEnd,
    relevant: judgement?.relevant[index] ?? false,
  }));

  const prices = deps.prices ?? NO_PRICES;
  const usage = resultUsage(answer.usage, prices);
  const result: QuestionResult = {
    ...base,
    retrieved: records,
    ...(judgement === undefined
      ? {}
      : (({ hit, precision, recall, mrr, ndcg }) => ({
          retrieval: { hit, precision, recall, mrr, ndcg },
        }))(retrievalMetrics(judgement, system.k))),
    answered: answer.answered,
    ...(answer.refusal === undefined ? {} : { refusal: answer.refusal }),
    ...(answer.answer === undefined ? {} : { answer: answer.answer }),
    ...(answer.tokens === undefined ? {} : { tokens: answer.tokens }),
    ...(usage === undefined ? {} : { usage }),
    latencyMs: answer.latencyMs,
  };

  // a refusal has no claims to check, and nothing to compare with the reference
  if (!generate || deps.judge === undefined || answer.answer === undefined || !answer.answered) {
    return result;
  }
  const { judge } = deps;
  const started = clock();
  // the judge is a model too, but it measures the system: its calls go on a trace of their own
  const judgeTrace = new Trace();
  const judgeUsage = (): { judgeUsage?: ReturnType<typeof resultUsage> } => {
    const used = resultUsage(usageOf(judgeTrace.snapshot().stages), prices);
    return used === undefined ? {} : { judgeUsage: used };
  };
  try {
    const judged = await withTrace(judgeTrace, () =>
      judge.judge(
        {
          question: question.question,
          answer: answer.answer ?? "",
          sources: answer.sources,
          reference: question.answer,
        },
        signal,
      ),
    );
    return {
      ...result,
      ...judgeUsage(),
      generation: {
        ...(judged.faithfulness.score === undefined
          ? {}
          : { faithfulness: judged.faithfulness.score }),
        relevance: judged.relevance.score,
        correctness: judged.correctness.score,
        promptVersions: judged.promptVersions,
      },
      latencyMs: { ...result.latencyMs, judge: clock() - started },
    };
  } catch (error) {
    signal?.throwIfAborted();
    return { ...result, ...judgeUsage(), error: `judge: ${message(error)}` };
  }
}

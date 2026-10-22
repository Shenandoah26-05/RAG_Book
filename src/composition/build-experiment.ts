import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { FileDocumentStore, FileExperimentStore } from "../adapters/index.js";
import { hashConfig, loadConfig } from "../config/index.js";
import type { Env, RagConfig } from "../config/index.js";
import type {
  DocId,
  Embedder,
  ExperimentSummary,
  LlmProvider,
  RetrievedChunk,
} from "../core/index.js";
import { contentHash } from "../core/index.js";
import {
  datasetMetaSchema,
  expandVariants,
  goldPassages,
  parseDataset,
  runExperiment,
} from "../eval/index.js";
import type {
  ExperimentVariant,
  GoldPassage,
  Question,
  SystemAnswer,
  VariantFactory,
  VariantSystem,
} from "../eval/index.js";
import { createConsoleLogger, makeDocId, RagError } from "../shared/index.js";
import type { Logger } from "../shared/index.js";
import { buildAnswerJudge } from "./build-answer-judge.js";
import { buildIndexer } from "./build-indexer.js";
import { DEFAULT_PROCESSED_DIR } from "./build-ingest.js";
import { buildPipelineWithConfig } from "./build-pipeline.js";
import { currentGitCommit } from "./git-commit.js";

/** Where runs are saved: `<this>/<experiment>/<timestamp>/`. */
export const DEFAULT_RESULTS_DIR = "evals/results";

/** What building a variant's index told us. */
export interface EnsuredIndex {
  readonly namespace: string;
  readonly status: "built" | "reused";
}

/**
 * Makes sure the index for a variant exists in `indexDir`, building it if not. A seam for tests:
 * the default runs the real indexer, which needs an embedding model.
 */
export type EnsureIndex = (request: {
  readonly configFile: string;
  readonly indexDir: string;
  readonly docId: DocId;
}) => Promise<EnsuredIndex>;

export interface BuildExperimentOptions {
  /** The experiment file, e.g. `evals/experiments/retrievers.json`. */
  readonly file: string;
  readonly env?: Env;
  /** Only these variants, by name. Default: all. */
  readonly only?: readonly string[];
  /** Only the first N questions of the dataset, for a quick try. */
  readonly limit?: number;
  /** Where runs are saved. Default `evals/results`. */
  readonly outDir?: string;
  readonly processedDir?: string;
  /** Where indexes are kept. Default `vectorStore.dir` (`data/index`). */
  readonly indexDir?: string;
  readonly cacheDir?: string;
  readonly promptsDir?: string;
  readonly logger?: Logger;
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
  /** The commit to record. Default: `git rev-parse HEAD`. */
  readonly gitCommit?: string | null;
  // The rest replace the real parts, for tests.
  readonly embedder?: Embedder;
  readonly llm?: LlmProvider;
  readonly judgeLlm?: LlmProvider;
  readonly ensureIndex?: EnsureIndex;
}

/** What `buildExperiment` knows before anything runs; `pnpm experiment --dry-run` prints it. */
export interface ExperimentPlan {
  readonly name: string;
  readonly description?: string;
  readonly generation: boolean;
  readonly dataset: string;
  readonly datasetVersion: string;
  readonly questions: number;
  readonly variants: readonly {
    readonly name: string;
    readonly settings: Readonly<Record<string, unknown>>;
  }[];
}

export interface Experiment {
  readonly plan: ExperimentPlan;
  /** Where this run will be saved. */
  readonly location: string;
  run(signal?: AbortSignal): Promise<ExperimentSummary>;
}

async function readJson(file: string, what: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (cause) {
    throw new RagError("INVALID_ARGUMENT", `Cannot read ${what} ${file}`, { cause });
  }
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new RagError("INVALID_ARGUMENT", `${what} ${file} is not valid JSON`, { cause });
  }
}

/** `2026-10-22T10:01:02.345Z` as `2026-10-22T10-01-02Z`: sorts in time order and is safe on Windows. */
const stamp = (date: Date): string =>
  date
    .toISOString()
    .replace(/\.\d+Z$/, "Z")
    .replace(/:/g, "-");

/**
 * The index folder for a variant. The index namespace names only the chunker and the embedder, so
 * two variants that differ in chunk size would otherwise share a folder and overwrite each other.
 * Keying the folder on the chunking and embedding settings gives each its own index, and lets
 * variants that differ only in retrieval, reranking or `k` share one.
 */
export function indexDirFor(baseDir: string, config: RagConfig): string {
  const key = contentHash(
    "experiment-index",
    JSON.stringify(config.ingestion),
    JSON.stringify(config.chunking),
    JSON.stringify(config.embedding),
  );
  return path.join(baseDir, `exp-${key.slice(0, 12)}`);
}

/**
 * Reads an experiment file and wires everything it needs: the dataset and the book it was written
 * for, a judge (only when answers are generated), and the factory that builds each variant.
 *
 * A variant is built like this:
 *
 *   its config, saved as a file --> loadConfig --> an index (built, or reused if one for the same
 *   chunking and embedding exists) --> the same `buildPipelineWithConfig` that `pnpm chat` uses
 *
 * so what is measured is the real pipeline, and the saved config file reproduces the variant. Which
 * strategies a variant uses is whatever its config names; nothing here looks at them.
 *
 * @throws RagError INVALID_ARGUMENT for a bad experiment or dataset, or a book that is not ingested
 */
export async function buildExperiment(options: BuildExperimentOptions): Promise<Experiment> {
  const {
    env = process.env,
    processedDir = DEFAULT_PROCESSED_DIR,
    logger = createConsoleLogger(),
    now = (): Date => new Date(),
  } = options;

  const { experiment, variants: all } = expandVariants(await readJson(options.file, "experiment"));
  const variants =
    options.only === undefined || options.only.length === 0
      ? all
      : selectVariants(all, options.only);

  const datasetFile = experiment.dataset;
  const allQuestions = parseDataset(await readFileText(datasetFile));
  const meta = datasetMetaSchema.parse(
    await readJson(datasetFile.replace(/\.jsonl$/, ".meta.json"), "dataset meta"),
  );
  const questions =
    options.limit === undefined ? allQuestions : allQuestions.slice(0, options.limit);

  const docId = makeDocId(meta.source.sha256);
  const doc = await new FileDocumentStore(processedDir).load(docId);
  if (doc === undefined) {
    throw new RagError(
      "INVALID_ARGUMENT",
      `The dataset was written for "${meta.source.title}" (${docId}), which is not in ${processedDir}. ` +
        'Run "pnpm ingest <book.pdf>" first.',
    );
  }
  const gold = new Map<string, readonly GoldPassage[]>(
    questions
      .filter((q: Question) => q.kind !== "unanswerable")
      .map((q: Question) => [q.id, goldPassages(doc, q)]),
  );

  const runDir = await freshRunDir(
    path.join(options.outDir ?? DEFAULT_RESULTS_DIR, experiment.name),
    stamp(now()),
  );
  const configsDir = path.join(runDir, "configs");

  const base = await writeConfig(configsDir, "_base", experiment.base);
  const baseConfig = await loadConfig({ argv: ["--config", base], env });
  const judge = experiment.generation
    ? buildAnswerJudge(baseConfig, {
        env,
        logger,
        ...(options.judgeLlm === undefined ? {} : { llm: options.judgeLlm }),
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        ...(options.promptsDir === undefined ? {} : { promptsDir: options.promptsDir }),
      })
    : undefined;

  const ensureIndex: EnsureIndex =
    options.ensureIndex ??
    (async ({ configFile, indexDir, docId: target }) => {
      const indexer = await buildIndexer({
        argv: ["--config", configFile],
        env,
        processedDir,
        indexDir,
        logger,
        ...(options.cacheDir === undefined ? {} : { cacheDir: options.cacheDir }),
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      });
      const result = await indexer.run({ targets: [target] });
      return {
        namespace: result.manifest.namespace,
        status: result.status === "built" ? "built" : "reused",
      };
    });

  const factory: VariantFactory = {
    async prepare(variant: ExperimentVariant): Promise<VariantSystem> {
      const configFile = await writeConfig(configsDir, variant.name, variant.config);
      const config = await loadConfig({ argv: ["--config", configFile], env });
      const indexDir = indexDirFor(options.indexDir ?? config.vectorStore.dir, config);
      const index = await ensureIndex({ configFile, indexDir, docId });
      const { pipeline } = await buildPipelineWithConfig({
        argv: ["--config", configFile],
        env,
        indexDir,
        logger,
        ...(options.cacheDir === undefined ? {} : { cacheDir: options.cacheDir }),
        ...(options.promptsDir === undefined ? {} : { promptsDir: options.promptsDir }),
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        ...(options.embedder === undefined ? {} : { embedder: options.embedder }),
        ...(options.llm === undefined ? {} : { llm: options.llm }),
      });
      return {
        configHash: hashConfig(config),
        configFile,
        k: config.retrieval.k,
        models: {
          embedder: `${config.embedding.provider}:${config.embedding.model}`,
          generator: pipeline.describe().llm,
        },
        index,
        ask: async (question, askOptions) => {
          const started = performance.now();
          const answer = await pipeline.ask(question, {
            ...(askOptions.signal === undefined ? {} : { signal: askOptions.signal }),
          });
          const retrievalMs = performance.now() - started;
          // the guardrail decides before the model is called, so this is known without reading
          const ground = answer.trace.stages.find((s) => s.stage === "ground")?.summary;
          const refused = ground?.["answered"] === false;
          const result: SystemAnswer = {
            // what the reranker kept, best first: the prompt's chunks and the ones the budget dropped
            retrieved: rankedChunks(answer.prompt),
            sources: answer.prompt.included.map((r) => r.chunk.text),
            answered: !refused,
            ...(typeof ground?.["refusal"] === "string" ? { refusal: ground["refusal"] } : {}),
            latencyMs: { retrieval: retrievalMs },
          };
          if (!askOptions.generate) return result;

          const generationStarted = performance.now();
          let text = "";
          let tokens: SystemAnswer["tokens"];
          for await (const delta of answer.stream) {
            if (delta.kind === "text") text += delta.text;
            else {
              tokens = {
                ...(delta.promptTokens === undefined ? {} : { prompt: delta.promptTokens }),
                ...(delta.outputTokens === undefined ? {} : { output: delta.outputTokens }),
              };
            }
          }
          return {
            ...result,
            answer: text,
            ...(tokens === undefined ? {} : { tokens }),
            latencyMs: {
              retrieval: retrievalMs,
              generation: performance.now() - generationStarted,
            },
          };
        },
      };
    },
  };

  const store = new FileExperimentStore(runDir);
  const gitCommit = options.gitCommit === undefined ? await currentGitCommit() : options.gitCommit;

  return {
    plan: {
      name: experiment.name,
      ...(experiment.description === undefined ? {} : { description: experiment.description }),
      generation: experiment.generation,
      dataset: datasetFile,
      datasetVersion: meta.version,
      questions: questions.length,
      variants: variants.map((v) => ({ name: v.name, settings: v.settings })),
    },
    location: runDir,
    run: (signal) =>
      runExperiment({
        experiment,
        variants,
        dataset: { path: datasetFile, version: meta.version },
        questions,
        gold,
        factory,
        ...(judge === undefined ? {} : { judge }),
        store,
        gitCommit,
        now,
        logger,
        ...(signal === undefined ? {} : { signal }),
      }),
  };
}

/**
 * A folder name for this run that no earlier run has used. Runs are named by the second, so two
 * started in the same second would otherwise share a folder and mix their results in one file.
 * Nothing is created here: a dry run must leave no trace.
 */
async function freshRunDir(parent: string, name: string): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    const candidate = path.join(parent, attempt === 1 ? name : `${name}-${attempt.toString()}`);
    try {
      await stat(candidate);
    } catch {
      return candidate;
    }
  }
}

function selectVariants(
  all: readonly ExperimentVariant[],
  names: readonly string[],
): readonly ExperimentVariant[] {
  const known = new Set(all.map((v) => v.name));
  const missing = names.filter((name) => !known.has(name));
  if (missing.length > 0) {
    throw new RagError(
      "INVALID_ARGUMENT",
      `No variant named ${missing.map((m) => `"${m}"`).join(", ")}. The experiment has: ${[...known].join(", ")}`,
    );
  }
  return all.filter((v) => names.includes(v.name));
}

/** The chunks the prompt used plus the ones it left out, best first. */
function rankedChunks(prompt: {
  readonly included: readonly RetrievedChunk[];
  readonly dropped: readonly { readonly chunk: RetrievedChunk }[];
}): readonly RetrievedChunk[] {
  return [...prompt.included, ...prompt.dropped.map((d) => d.chunk)].sort(
    (a, b) => a.rank - b.rank,
  );
}

async function writeConfig(dir: string, name: string, config: Readonly<Record<string, unknown>>) {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${name}.json`);
  await writeFile(file, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return file;
}

async function readFileText(file: string): Promise<string> {
  try {
    return await readFile(file, "utf8");
  } catch (cause) {
    throw new RagError("INVALID_ARGUMENT", `Cannot read the dataset ${file}`, { cause });
  }
}

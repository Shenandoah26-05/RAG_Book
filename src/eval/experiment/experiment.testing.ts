// Fakes for the tests of the experiment runner. Not part of the build (see tsconfig.build.json).
import { makeChunkId } from "../../core/index.js";
import type {
  AnswerJudge,
  AnswerJudgement,
  Chunk,
  ExperimentStore,
  ExperimentSummary,
  QuestionResult,
  RetrievedChunk,
} from "../../core/index.js";
import { makeDocId } from "../../shared/index.js";
import type { Question } from "../dataset/index.js";
import type { GoldPassage } from "../metrics/index.js";
import type { ExperimentVariant } from "./expand-variants.js";
import type { SystemAnswer, VariantFactory, VariantSystem } from "./system.js";

export const DOC = makeDocId("d".repeat(64));

/** A chunk covering `[start, end)` of the document. */
export function chunkAt(start: number, end: number, text = `chunk ${start.toString()}`): Chunk {
  return {
    id: makeChunkId({ docId: DOC, strategy: "fake", charStart: start, charEnd: end, text }),
    text,
    metadata: {
      docId: DOC,
      pageStart: 1,
      pageEnd: 1,
      sectionPath: [],
      charStart: start,
      charEnd: end,
      strategy: "fake",
    },
  };
}

/** Results for the chunks, best first, ranked from 1. */
export function ranked(...chunks: Chunk[]): RetrievedChunk[] {
  return chunks.map((chunk, index) => ({
    chunk,
    score: 1 - index * 0.1,
    rank: index + 1,
    retriever: "fake",
  }));
}

export function question(
  id: string,
  kind: Question["kind"] = "factual",
  overrides: Partial<Question> = {},
): Question {
  return {
    id,
    question: `Question ${id}?`,
    kind,
    answer: `Reference ${id}`,
    gold: kind === "unanswerable" ? [] : [{ page: 1, quote: "some words on page one" }],
    ...overrides,
  };
}

/** The gold span of every answerable question: characters 100 to 200. */
export function goldFor(questions: readonly Question[]): Map<string, readonly GoldPassage[]> {
  return new Map(
    questions
      .filter((q) => q.kind !== "unanswerable")
      .map((q) => [q.id, [{ docId: DOC, span: { start: 100, end: 200 } }]]),
  );
}

export function variant(name: string): ExperimentVariant {
  return { name, settings: { name }, config: { name } };
}

export interface FakeSystemOptions {
  readonly k?: number;
  readonly answer?: (question: string, generate: boolean) => SystemAnswer | Promise<SystemAnswer>;
}

/** A system that answers every question with `answer`, and records how it was asked. */
export function fakeSystem(options: FakeSystemOptions = {}): VariantSystem & {
  readonly asked: { question: string; generate: boolean }[];
} {
  const asked: { question: string; generate: boolean }[] = [];
  const fallback = (): SystemAnswer => ({
    retrieved: ranked(chunkAt(0, 50), chunkAt(150, 180), chunkAt(300, 350)),
    sources: ["source one", "source two"],
    answered: true,
    latencyMs: { retrieval: 10 },
  });
  return {
    asked,
    configHash: "hash-1",
    configFile: "configs/x.json",
    k: options.k ?? 3,
    models: { embedder: "ollama:embed", generator: "ollama:gen" },
    index: { namespace: "recursive__ollama-embed", status: "reused" },
    ask: async (text, askOptions) => {
      asked.push({ question: text, generate: askOptions.generate });
      return (options.answer ?? fallback)(text, askOptions.generate);
    },
  };
}

export function factoryOf(
  build: (variant: ExperimentVariant) => VariantSystem | Promise<VariantSystem>,
): VariantFactory & { readonly prepared: string[] } {
  const prepared: string[] = [];
  return {
    prepared,
    prepare: async (v) => {
      prepared.push(v.name);
      return build(v);
    },
  };
}

export function memoryStore(): ExperimentStore & {
  readonly results: QuestionResult[];
  readonly summaries: ExperimentSummary[];
} {
  const results: QuestionResult[] = [];
  const summaries: ExperimentSummary[] = [];
  return {
    location: "memory",
    results,
    summaries,
    append: (result) => {
      results.push(result);
      return Promise.resolve();
    },
    finish: (summary) => {
      summaries.push(summary);
      return Promise.resolve();
    },
  };
}

export function fakeJudge(
  judge: (input: Parameters<AnswerJudge["judge"]>[0]) => AnswerJudgement | Error,
): AnswerJudge & { readonly inputs: Parameters<AnswerJudge["judge"]>[0][] } {
  const inputs: Parameters<AnswerJudge["judge"]>[0][] = [];
  return {
    modelId: "ollama:judge",
    inputs,
    judge: (input) => {
      inputs.push(input);
      const outcome = judge(input);
      return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
    },
  };
}

export const judgement = (
  faithfulness: number | undefined,
  relevance: number,
  correctness: number,
): AnswerJudgement => ({
  faithfulness: { score: faithfulness, claims: [] },
  relevance: { score: relevance, reason: "r" },
  correctness: { score: correctness, reason: "c" },
  judgeModel: "ollama:judge",
  promptVersions: ["judge-faithfulness@v1"],
});

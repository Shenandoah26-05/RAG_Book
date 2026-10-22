import { describe, expect, it } from "vitest";
import { runExperiment } from "./run-experiment.js";
import type { RunExperimentDeps } from "./run-experiment.js";
import {
  chunkAt,
  factoryOf,
  fakeJudge,
  fakeSystem,
  goldFor,
  judgement,
  memoryStore,
  question,
  ranked,
  variant,
} from "./experiment.testing.js";

const questions = [
  question("q001"),
  question("q002", "multi-part"),
  question("q003", "unanswerable"),
];

function setup(overrides: Partial<RunExperimentDeps> = {}) {
  const store = memoryStore();
  const system = fakeSystem();
  const factory = factoryOf(() => system);
  const deps: RunExperimentDeps = {
    experiment: { name: "exp", generation: false },
    variants: [variant("a")],
    dataset: { path: "evals/datasets/v1.jsonl", version: "v1" },
    questions,
    gold: goldFor(questions),
    factory,
    store,
    gitCommit: "abc1234",
    now: () => new Date("2026-10-22T10:00:00.000Z"),
    ...overrides,
  };
  return { deps, store, system, factory };
}

describe("runExperiment", () => {
  it("saves one result per variant and question, in order, as they finish", async () => {
    const { deps, store } = setup({ variants: [variant("a"), variant("b")] });
    await runExperiment(deps);
    expect(store.results.map((r) => `${r.variant}/${r.questionId}`)).toEqual([
      "a/q001",
      "a/q002",
      "a/q003",
      "b/q001",
      "b/q002",
      "b/q003",
    ]);
  });

  it("puts the provenance on every result", async () => {
    const { deps, store } = setup();
    await runExperiment(deps);
    for (const result of store.results) {
      expect(result).toMatchObject({
        experiment: "exp",
        variant: "a",
        configHash: "hash-1",
        gitCommit: "abc1234",
        datasetVersion: "v1",
        models: { embedder: "ollama:embed", generator: "ollama:gen" },
        k: 3,
      });
      expect(result.models).not.toHaveProperty("judge");
    }
  });

  it("scores retrieval against the gold span: hand-computed values", async () => {
    // gold is [100, 200). Rank 1 misses, rank 2 overlaps, rank 3 misses.
    const { deps, store } = setup();
    await runExperiment(deps);
    const first = store.results[0];
    expect(first?.retrieved.map((r) => [r.rank, r.relevant])).toEqual([
      [1, false],
      [2, true],
      [3, false],
    ]);
    expect(first?.retrieval).toEqual({
      hit: 1,
      precision: 1 / 3,
      recall: 1,
      mrr: 1 / 2,
      ndcg: 1 / Math.log2(3),
    });
  });

  it("cuts a longer result list to the variant's k", async () => {
    const system = fakeSystem({
      k: 2,
      answer: () => ({
        retrieved: ranked(chunkAt(0, 50), chunkAt(60, 70), chunkAt(150, 180)),
        sources: [],
        answered: true,
        latencyMs: { retrieval: 1 },
      }),
    });
    const { deps, store } = setup({ factory: factoryOf(() => system) });
    await runExperiment(deps);
    expect(store.results[0]?.retrieved).toHaveLength(2);
    // the relevant chunk was third, so it does not count at k = 2
    expect(store.results[0]?.retrieval?.hit).toBe(0);
  });

  it("gives an unanswerable question no retrieval scores, only whether it was refused", async () => {
    const system = fakeSystem({
      answer: (text) => {
        const refused = text.includes("q003");
        return {
          retrieved: ranked(chunkAt(0, 50)),
          sources: [],
          answered: !refused,
          ...(refused ? { refusal: "low-score" } : {}),
          latencyMs: { retrieval: 1 },
        };
      },
    });
    const { deps, store } = setup({ factory: factoryOf(() => system) });
    const summary = await runExperiment(deps);
    const unanswerable = store.results.find((r) => r.questionId === "q003");
    expect(unanswerable).not.toHaveProperty("retrieval");
    expect(unanswerable).toMatchObject({ answered: false, refusal: "low-score" });
    expect(summary.variants[0]?.refusals).toEqual({
      unanswerableRefused: 1,
      answerableRefused: 0,
    });
    expect(summary.variants[0]?.questions).toEqual({
      total: 3,
      answerable: 2,
      unanswerable: 1,
      failed: 0,
    });
  });

  it("asks without generating when the experiment is retrieval only", async () => {
    const { deps, system } = setup();
    await runExperiment(deps);
    expect(system.asked.every((a) => !a.generate)).toBe(true);
    expect(system.asked.map((a) => a.question)).toEqual([
      "Question q001?",
      "Question q002?",
      "Question q003?",
    ]);
  });

  it("builds each variant once, and hands the factory the variant untouched", async () => {
    const { deps, factory } = setup({ variants: [variant("a"), variant("b")] });
    await runExperiment(deps);
    expect(factory.prepared).toEqual(["a", "b"]);
  });

  describe("when something fails", () => {
    it("records a variant that cannot be built and goes on to the next", async () => {
      const good = fakeSystem();
      const factory = factoryOf((v) => {
        if (v.name === "bad") throw new Error("no such retriever");
        return good;
      });
      const { deps, store } = setup({ variants: [variant("bad"), variant("good")], factory });
      const summary = await runExperiment(deps);

      expect(summary.variants.map((v) => [v.variant, v.error])).toEqual([
        ["bad", "no such retriever"],
        ["good", undefined],
      ]);
      expect(store.results.every((r) => r.variant === "good")).toBe(true);
    });

    it("saves a question that fails with its error, and leaves it out of the means", async () => {
      const system = fakeSystem({
        answer: (text) => {
          if (text.includes("q002")) throw new Error("model down");
          return {
            retrieved: ranked(chunkAt(150, 160)),
            sources: [],
            answered: true,
            latencyMs: { retrieval: 5 },
          };
        },
      });
      const { deps, store } = setup({ factory: factoryOf(() => system) });
      const summary = await runExperiment(deps);

      expect(store.results.find((r) => r.questionId === "q002")).toMatchObject({
        error: "model down",
        retrieved: [],
      });
      const [only] = summary.variants;
      expect(only?.questions.failed).toBe(1);
      // the mean covers q001 only (q002 failed, q003 is unanswerable), so one error is not a zero
      expect(only?.retrieval).toMatchObject({ questions: 1, hit: 1 });
    });
  });

  describe("generation", () => {
    const withAnswers = (overrides: Partial<RunExperimentDeps> = {}) => {
      const system = fakeSystem({
        answer: (_text, generate) => ({
          retrieved: ranked(chunkAt(150, 160)),
          sources: ["the source"],
          answered: true,
          ...(generate ? { answer: "The answer [1].", tokens: { prompt: 100, output: 20 } } : {}),
          latencyMs: { retrieval: 4, ...(generate ? { generation: 40 } : {}) },
        }),
      });
      return setup({
        experiment: { name: "exp", generation: true },
        factory: factoryOf(() => system),
        ...overrides,
      });
    };

    it("needs a judge", async () => {
      const { deps } = withAnswers();
      await expect(runExperiment(deps)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    });

    it("asks the system to generate, judges each answer and names the judge model", async () => {
      const judge = fakeJudge(() => judgement(0.5, 1, 0.5));
      const { deps, store, system } = withAnswers({ judge });
      const summary = await runExperiment(deps);

      expect(system.asked.every((a) => a.generate)).toBe(true);
      expect(judge.inputs[0]).toEqual({
        question: "Question q001?",
        answer: "The answer [1].",
        sources: ["the source"],
        reference: "Reference q001",
      });
      const first = store.results[0];
      expect(first?.models.judge).toBe("ollama:judge");
      expect(first?.generation).toEqual({
        faithfulness: 0.5,
        relevance: 1,
        correctness: 0.5,
        promptVersions: ["judge-faithfulness@v1"],
      });
      expect(first?.latencyMs).toMatchObject({ retrieval: 4, generation: 40 });
      expect(first?.latencyMs.judge).toBeTypeOf("number");
      expect(summary.variants[0]?.generation).toEqual({
        judged: 3,
        faithfulness: 0.5,
        relevance: 1,
        correctness: 0.5,
      });
      expect(summary.variants[0]?.tokens).toEqual({ prompt: 300, output: 60 });
    });

    it("leaves faithfulness out when the answer made no claim", async () => {
      const judge = fakeJudge(() => judgement(undefined, 1, 1));
      const { deps, store } = withAnswers({ judge });
      const summary = await runExperiment(deps);
      expect(store.results[0]?.generation).not.toHaveProperty("faithfulness");
      expect(summary.variants[0]?.generation).not.toHaveProperty("faithfulness");
    });

    it("does not judge a refusal", async () => {
      const system = fakeSystem({
        answer: () => ({
          retrieved: [],
          sources: [],
          answered: false,
          refusal: "no-sources",
          answer: "I could not find the answer to that in the book.",
          latencyMs: { retrieval: 1, generation: 1 },
        }),
      });
      const judge = fakeJudge(() => judgement(1, 1, 1));
      const { deps, store } = setup({
        experiment: { name: "exp", generation: true },
        factory: factoryOf(() => system),
        judge,
      });
      await runExperiment(deps);
      expect(judge.inputs).toHaveLength(0);
      expect(store.results.every((r) => r.generation === undefined && !r.answered)).toBe(true);
    });

    it("keeps the retrieval scores when the judge fails, and marks the question failed", async () => {
      const judge = fakeJudge(() => new Error("bad JSON from the judge"));
      const { deps, store } = withAnswers({ judge });
      const summary = await runExperiment(deps);
      expect(store.results[0]).toMatchObject({
        error: "judge: bad JSON from the judge",
        retrieval: { hit: 1 },
      });
      expect(summary.variants[0]?.questions.failed).toBe(3);
    });

    it("times the judge with the clock it is given", async () => {
      const ticks = [1000, 1250];
      let i = 0;
      const judge = fakeJudge(() => judgement(1, 1, 1));
      const { deps, store } = withAnswers({
        judge,
        questions: [question("q001")],
        gold: goldFor([question("q001")]),
        clock: () => ticks[i++] ?? 0,
      });
      await runExperiment(deps);
      expect(store.results[0]?.latencyMs.judge).toBe(250);
    });
  });

  it("writes the summary once, after the last result, and returns it", async () => {
    const { deps, store } = setup();
    const summary = await runExperiment(deps);
    expect(store.summaries).toEqual([summary]);
    expect(summary).toMatchObject({
      experiment: "exp",
      dataset: "evals/datasets/v1.jsonl",
      datasetVersion: "v1",
      gitCommit: "abc1234",
      startedAt: "2026-10-22T10:00:00.000Z",
      finishedAt: "2026-10-22T10:00:00.000Z",
      generation: false,
    });
    expect(summary.variants[0]).toMatchObject({
      variant: "a",
      configHash: "hash-1",
      configFile: "configs/x.json",
      k: 3,
      index: { namespace: "recursive__ollama-embed", status: "reused" },
    });
  });

  it("stops when aborted, keeping what is saved, and writes no summary", async () => {
    const controller = new AbortController();
    const system = fakeSystem({
      answer: (text) => {
        if (text.includes("q002")) controller.abort();
        return { retrieved: [], sources: [], answered: true, latencyMs: { retrieval: 1 } };
      },
    });
    const { deps, store } = setup({ factory: factoryOf(() => system), signal: controller.signal });
    await expect(runExperiment(deps)).rejects.toBeDefined();
    expect(store.results.map((r) => r.questionId)).toEqual(["q001", "q002"]);
    expect(store.summaries).toEqual([]);
  });
});

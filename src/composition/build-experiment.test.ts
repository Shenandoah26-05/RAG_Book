import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FileDocumentStore, FileIndexWriter } from "../adapters/index.js";
import { INDEX_MANIFEST_VERSION, makeChunkId } from "../core/index.js";
import type {
  Chunk,
  Embedder,
  IndexContents,
  LlmProvider,
  ParsedDocument,
  QuestionResult,
} from "../core/index.js";
import { indexNamespace } from "../pipeline/index.js";
import { makeDocId } from "../shared/index.js";
import { Bm25Index, MeteredEmbedder, MeteredProvider } from "../strategies/index.js";
import { makeDocument } from "../testing/make-document.testing.js";
import { buildExperiment, indexDirFor } from "./build-experiment.js";
import { buildReport } from "./build-report.js";
import type { BuildExperimentOptions, EnsureIndex } from "./build-experiment.js";
import { DEFAULT_CONFIG } from "../config/index.js";

const SHA = "a".repeat(64);
const DOC = makeDocId(SHA);
const NAMESPACE = indexNamespace("recursive", "ollama:all-minilm");

const CATS = "Cats purr when they are content.";
const DOGS = "Dogs bark at strangers loudly.";
const STOCKS = "Stock markets fell sharply on Monday.";

const unit = (...v: number[]): Float32Array => {
  const length = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return Float32Array.from(v.map((x) => x / length));
};
/** Texts map to fixed directions, so each question points at its own chunk. */
const DIRECTIONS: Record<string, Float32Array> = {
  [CATS]: unit(1, 0, 0),
  [DOGS]: unit(0.1, 1, 0),
  [STOCKS]: unit(0, 0.1, 1),
  "Tell me about cats": unit(1, 0.05, 0),
  "What happened to stock markets": unit(0, 0.05, 1),
  "Who won the 1990 world cup": unit(0.5, 0.5, 0.5),
};
const embedder: Embedder = {
  modelId: "ollama:all-minilm",
  dimensions: 3,
  embed: (texts) => Promise.resolve(texts.map((t) => DIRECTIONS[t] ?? unit(1, 1, 1))),
};

const generator: LlmProvider = {
  modelId: "fake:generator",
  async *chat() {
    await Promise.resolve();
    yield { kind: "text", text: "Cats purr [1]." } as const;
    yield { kind: "end", reason: "stop", promptTokens: 120, outputTokens: 5 } as const;
  },
};

/** Answers each judge prompt with a reply of the right shape, found by what the prompt asks. */
const judgeLlm: LlmProvider = {
  modelId: "fake:judge",
  async *chat(messages) {
    await Promise.resolve();
    const prompt = messages.map((m) => m.content).join("\n");
    const reply = prompt.startsWith("You check whether an answer is supported")
      ? '{"claims":[{"claim":"Cats purr","supported":true},{"claim":"Cats bark","supported":false}]}'
      : prompt.startsWith("You judge whether an answer addresses")
        ? '{"reason":"on point","verdict":"answers"}'
        : '{"reason":"half","verdict":"partial"}';
    yield { kind: "text", text: reply } as const;
    yield { kind: "end", reason: "stop" } as const;
  },
};

const document: ParsedDocument = {
  ...makeDocument([`${CATS}\n${DOGS}`, STOCKS]),
  id: DOC,
  sha256: SHA,
  title: "Animals and markets",
};

function chunkOf(text: string): Chunk {
  const start = document.text.indexOf(text);
  const page = document.pages.find((p) => p.span.start <= start && start < p.span.end);
  return {
    id: makeChunkId({
      docId: DOC,
      strategy: "recursive",
      charStart: start,
      charEnd: start + text.length,
      text,
    }),
    text,
    metadata: {
      docId: DOC,
      pageStart: page?.number ?? 1,
      pageEnd: page?.number ?? 1,
      sectionPath: [],
      charStart: start,
      charEnd: start + text.length,
      strategy: "recursive",
    },
  };
}

function indexContents(): IndexContents {
  const chunks = [CATS, DOGS, STOCKS].map(chunkOf);
  const keyword = new Bm25Index();
  keyword.add(chunks);
  return {
    manifest: {
      version: INDEX_MANIFEST_VERSION,
      namespace: NAMESPACE,
      createdAt: "2026-10-22T10:00:00.000Z",
      gitCommit: null,
      configHash: "c".repeat(64),
      fingerprint: "f".repeat(64),
      chunker: { name: "recursive", tokenizer: "approx", maxTokens: 400, overlapTokens: 60 },
      embedder: { modelId: embedder.modelId, dimensions: 3, batchSize: 32 },
      documents: [DOC],
      counts: { documents: 1, chunks: 3, parents: 0, vectors: 3 },
      timingsMs: { total: 1 },
    },
    chunks,
    vectors: chunks.map((c) => ({
      id: c.id,
      vector: DIRECTIONS[c.text] as Float32Array,
      metadata: c.metadata,
    })),
    keywordIndex: keyword.serialize(),
  };
}

const dataset = [
  {
    id: "q001",
    question: "Tell me about cats",
    kind: "factual",
    answer: "Cats purr when content.",
    gold: [{ page: 1, quote: CATS }],
  },
  {
    id: "q002",
    question: "What happened to stock markets",
    kind: "factual",
    answer: "They fell sharply on Monday.",
    gold: [{ page: 2, quote: STOCKS }],
  },
  {
    id: "q003",
    question: "Who won the 1990 world cup",
    kind: "unanswerable",
    answer: "The book does not say.",
    gold: [],
  },
];

let workdir: string;
let processedDir: string;
let datasetFile: string;
const promptsDir = path.resolve("prompts");

beforeAll(async () => {
  workdir = await mkdtemp(path.join(tmpdir(), "rag-build-experiment-"));
  processedDir = path.join(workdir, "processed");
  await new FileDocumentStore(processedDir).save(document);
  datasetFile = path.join(workdir, "dataset.jsonl");
  await writeFile(datasetFile, dataset.map((q) => JSON.stringify(q)).join("\n"));
  await writeFile(
    path.join(workdir, "dataset.meta.json"),
    JSON.stringify({
      version: "test-1",
      source: { title: "Animals and markets", sha256: SHA, pageCount: 2 },
    }),
  );
});
afterAll(async () => {
  await rm(workdir, { recursive: true, force: true });
});

/** An index "builder" that writes the fixture index, and remembers which folders it was asked for. */
function fakeIndexer(): { ensureIndex: EnsureIndex; built: string[]; asked: string[] } {
  const built: string[] = [];
  const asked: string[] = [];
  return {
    built,
    asked,
    ensureIndex: async ({ indexDir }) => {
      asked.push(indexDir);
      if (built.includes(indexDir)) return { namespace: NAMESPACE, status: "reused" };
      built.push(indexDir);
      await new FileIndexWriter(indexDir).write(indexContents());
      return { namespace: NAMESPACE, status: "built" };
    },
  };
}

let runs = 0;
async function experimentFile(spec: Record<string, unknown>): Promise<string> {
  const file = path.join(workdir, `experiment-${(runs++).toString()}.json`);
  await writeFile(file, JSON.stringify({ dataset: datasetFile, ...spec }));
  return file;
}

async function options(
  spec: Record<string, unknown>,
  extra: Partial<BuildExperimentOptions> = {},
): Promise<BuildExperimentOptions> {
  return {
    file: await experimentFile(spec),
    env: {},
    processedDir,
    outDir: path.join(workdir, "results"),
    indexDir: path.join(workdir, "indexes"),
    promptsDir,
    embedder,
    llm: generator,
    judgeLlm,
    gitCommit: "abc1234",
    now: () => new Date("2026-10-22T10:01:02.345Z"),
    ensureIndex: fakeIndexer().ensureIndex,
    ...extra,
  };
}

async function results(location: string): Promise<QuestionResult[]> {
  const text = await readFile(path.join(location, "results.jsonl"), "utf8");
  return text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as QuestionResult);
}

describe("buildExperiment: retrieval", () => {
  const spec = {
    name: "retrievers",
    matrix: { "retrieval.strategy": ["dense", "bm25"] },
    base: { retrieval: { k: 2 } },
  };

  it("plans the variants and the dataset without running anything", async () => {
    const experiment = await buildExperiment(await options(spec));
    expect(experiment.plan).toMatchObject({
      name: "retrievers",
      generation: false,
      datasetVersion: "test-1",
      questions: 3,
    });
    expect(experiment.plan.variants.map((v) => v.name)).toEqual([
      "retrieval.strategy=dense",
      "retrieval.strategy=bm25",
    ]);
    expect(experiment.location).toBe(
      path.join(workdir, "results", "retrievers", "2026-10-22T10-01-02Z"),
    );
  });

  it("runs every variant over every question and saves results and summary", async () => {
    const experiment = await buildExperiment(await options(spec));
    const summary = await experiment.run();

    const saved = await results(experiment.location);
    expect(saved).toHaveLength(6);
    expect(saved.map((r) => `${r.variant}/${r.questionId}`)).toEqual([
      "retrieval.strategy=dense/q001",
      "retrieval.strategy=dense/q002",
      "retrieval.strategy=dense/q003",
      "retrieval.strategy=bm25/q001",
      "retrieval.strategy=bm25/q002",
      "retrieval.strategy=bm25/q003",
    ]);
    const onDisk = JSON.parse(
      await readFile(path.join(experiment.location, "summary.json"), "utf8"),
    ) as typeof summary;
    expect(onDisk).toEqual(JSON.parse(JSON.stringify(summary)));
  });

  it("scores the real pipeline: the right chunk is found for an answerable question", async () => {
    const experiment = await buildExperiment(await options(spec));
    await experiment.run();
    const dense = (await results(experiment.location)).filter(
      (r) => r.variant === "retrieval.strategy=dense",
    );
    expect(dense[0]?.retrieved[0]).toMatchObject({ relevant: true, pageStart: 1 });
    expect(dense[0]?.retrieval).toMatchObject({ hit: 1, mrr: 1, recall: 1 });
    expect(dense[1]?.retrieved[0]).toMatchObject({ relevant: true, pageStart: 2 });
    expect(dense[2]).not.toHaveProperty("retrieval");
  });

  it("records the provenance: config hash, commit, dataset version, model names", async () => {
    const experiment = await buildExperiment(await options(spec));
    const summary = await experiment.run();
    const saved = await results(experiment.location);
    const first = saved[0] as QuestionResult;
    expect(first).toMatchObject({
      experiment: "retrievers",
      gitCommit: "abc1234",
      datasetVersion: "test-1",
      k: 2,
      models: { embedder: "ollama:all-minilm", generator: "fake:generator" },
    });
    expect(first.configHash).toMatch(/^[0-9a-f]{64}$/);
    // different settings, different hash; the same settings on every question of a variant
    const hashes = new Set(saved.map((r) => r.configHash));
    expect(hashes.size).toBe(2);
    expect(summary.gitCommit).toBe("abc1234");
    expect(summary.variants.map((v) => v.configHash).sort()).toEqual([...hashes].sort());
  });

  it("saves each variant's config file, which reproduces the run", async () => {
    const experiment = await buildExperiment(await options(spec));
    const summary = await experiment.run();
    const [first] = summary.variants;
    expect(JSON.parse(await readFile(first?.configFile ?? "", "utf8"))).toEqual({
      retrieval: { k: 2, strategy: "dense" },
    });
    expect((await readdir(path.join(experiment.location, "configs"))).sort()).toEqual([
      "_base.json",
      "retrieval.strategy=bm25.json",
      "retrieval.strategy=dense.json",
    ]);
  });

  it("does not ask the model for answers when generation is off", async () => {
    let calls = 0;
    const counting: LlmProvider = {
      modelId: "fake:generator",
      chat: (...args) => {
        calls++;
        return generator.chat(...args);
      },
    };
    const experiment = await buildExperiment(await options(spec, { llm: counting }));
    await experiment.run();
    // the default rewrite step needs history, which a dataset question does not have
    expect(calls).toBe(0);
    expect((await results(experiment.location)).every((r) => r.answer === undefined)).toBe(true);
  });

  it("reports whether the unanswerable question was refused", async () => {
    // with a minimum score nothing reaches, the guardrail refuses before the model is called
    const experiment = await buildExperiment(
      await options({ ...spec, base: { retrieval: { k: 2 }, grounding: { minScore: 99 } } }),
    );
    await experiment.run();
    const saved = await results(experiment.location);
    expect(saved.every((r) => !r.answered)).toBe(true);
    // BM25 finds nothing at all for the question about football, so it has no sources to score
    expect(saved.map((r) => r.refusal)).toEqual([
      "low-score",
      "low-score",
      "low-score",
      "low-score",
      "low-score",
      "no-sources",
    ]);
  });

  it("limits the questions and the variants", async () => {
    const experiment = await buildExperiment(
      await options(spec, { limit: 1, only: ["retrieval.strategy=bm25"] }),
    );
    expect(experiment.plan.questions).toBe(1);
    await experiment.run();
    expect((await results(experiment.location)).map((r) => r.variant)).toEqual([
      "retrieval.strategy=bm25",
    ]);
  });
});

describe("buildExperiment: indexes", () => {
  it("shares one index between variants that differ only in retrieval, and builds one per chunking", async () => {
    const indexer = fakeIndexer();
    const experiment = await buildExperiment(
      await options(
        {
          name: "indexes",
          matrix: { "chunking.maxTokens": [200, 400], "retrieval.strategy": ["dense", "bm25"] },
        },
        { ensureIndex: indexer.ensureIndex },
      ),
    );
    const summary = await experiment.run();

    expect(indexer.asked).toHaveLength(4);
    expect(new Set(indexer.asked).size).toBe(2);
    expect(indexer.built).toHaveLength(2);
    expect(summary.variants.map((v) => v.index.status)).toEqual([
      "built",
      "reused",
      "built",
      "reused",
    ]);
  });

  it("keys the folder on chunking and embedding, not on retrieval", () => {
    const folder = (change: object) => indexDirFor("data/index", { ...DEFAULT_CONFIG, ...change });
    expect(folder({})).toBe(folder({ retrieval: { ...DEFAULT_CONFIG.retrieval, k: 9 } }));
    expect(folder({})).not.toBe(
      folder({ chunking: { ...DEFAULT_CONFIG.chunking, maxTokens: 123 } }),
    );
    expect(folder({})).not.toBe(
      folder({ embedding: { ...DEFAULT_CONFIG.embedding, model: "other" } }),
    );
    expect(folder({})).toMatch(/exp-[0-9a-f]{12}$/);
  });

  it("records a variant that cannot be built and still runs the others", async () => {
    const experiment = await buildExperiment(
      await options({
        name: "mixed",
        variants: [
          { name: "broken", config: { retrieval: { strategy: "no-such-retriever" } } },
          { name: "fine", config: {} },
        ],
      }),
    );
    const summary = await experiment.run();
    expect(summary.variants.map((v) => [v.variant, v.error !== undefined])).toEqual([
      ["broken", true],
      ["fine", false],
    ]);
    expect(summary.variants[0]?.error).toContain("no-such-retriever");
    expect((await results(experiment.location)).every((r) => r.variant === "fine")).toBe(true);
  });

  it("records a config the loader rejects as a variant error", async () => {
    const experiment = await buildExperiment(
      await options({
        name: "bad",
        variants: [{ name: "typo", config: { chunking: { maxToken: 1 } } }],
      }),
    );
    const summary = await experiment.run();
    expect(summary.variants[0]?.error).toMatch(/maxToken/);
  });
});

// The report reads the files the runner writes. Checking it against real output, not hand-made
// fixtures, is what keeps the two from drifting apart.
describe("buildExperiment: the report reads what the runner wrote", () => {
  it.each([false, true])("with generation %s", async (generation) => {
    const experiment = await buildExperiment(
      await options({
        name: "reported",
        generation,
        variants: [
          { name: "dense", config: { retrieval: { strategy: "dense", k: 2 } } },
          { name: "bm25", config: { retrieval: { strategy: "bm25", k: 2 } } },
        ],
      }),
    );
    await experiment.run();
    const report = await buildReport({ target: experiment.location });

    expect(report.markdown).toContain("# Experiment reported: A/B report");
    expect(report.markdown).toContain("### `dense`");
    expect(report.markdown).toContain("### `bm25`");
    // the configs come from the run's own folder
    expect(report.markdown).toContain('"strategy": "bm25"');
    expect(report.markdown.includes("correctness")).toBe(generation);
  });
});

// The model and embedder are metered where the real builders meter them, so the experiment sees every
// call made for a question on its trace and prices it from the config.
describe("buildExperiment: what a run costs", () => {
  // 120 tokens in at 1,000 per million and 5 out at 2,000 per million: 0.12 + 0.01 for each answer
  const PRICING = {
    currency: "USD",
    models: { "fake:generator": { inputPerMillion: 1000, outputPerMillion: 2000 } },
  };
  const metered = {
    llm: new MeteredProvider(generator),
    judgeLlm: new MeteredProvider(judgeLlm),
    embedder: new MeteredEmbedder(embedder),
  };

  async function costed() {
    const experiment = await buildExperiment(
      await options(
        {
          name: "costed",
          generation: true,
          base: { pricing: PRICING },
          variants: [
            { name: "dense", config: { retrieval: { strategy: "dense", k: 2 } } },
            { name: "bm25", config: { retrieval: { strategy: "bm25", k: 2 } } },
          ],
        },
        metered,
      ),
    );
    const summary = await experiment.run();
    return { experiment, summary, saved: await results(experiment.location) };
  }

  it("records the calls made for each question and prices them", async () => {
    const { saved } = await costed();
    const first = saved.find((r) => r.variant === "dense" && r.questionId === "q001");
    expect(first?.usage).toMatchObject({
      // the answer, and the embedding of the question
      calls: 2,
      promptTokens: 120,
      outputTokens: 5,
      cost: expect.closeTo(0.13, 9) as number,
    });
    // 18 characters of question at 4 per token, for a model with no price
    expect(first?.usage?.embeddedTokens).toBe(5);
    expect(first?.usage?.unpricedTokens).toBe(5);
  });

  it("makes no call, and so records no usage, for a question the system refuses", async () => {
    const { saved } = await costed();
    // BM25 finds nothing for the question about football, so the model is never asked
    const refused = saved.find((r) => r.variant === "bm25" && r.questionId === "q003");
    expect(refused?.answered).toBe(false);
    expect(refused).not.toHaveProperty("usage");
  });

  it("totals the cost per 100 questions for each variant", async () => {
    const { summary } = await costed();
    const [dense, bm25] = summary.variants;
    // dense answered all 3 questions: 3 x 0.13 = 0.39 in all, 13.00 per 100 questions
    expect(dense?.cost).toMatchObject({
      currency: "USD",
      total: expect.closeTo(0.39, 9) as number,
      per100Questions: expect.closeTo(13, 9) as number,
    });
    // BM25 answered 2 of 3: 0.26 over 3 questions
    expect(bm25?.cost?.total).toBeCloseTo(0.26, 9);
    expect(bm25?.cost?.per100Questions).toBeCloseTo((0.26 / 3) * 100, 9);
  });

  it("keeps the judge's calls apart from the system's", async () => {
    const { summary, saved } = await costed();
    // three judge prompts per answer (faithfulness, relevance, correctness)
    const first = saved.find((r) => r.variant === "dense" && r.questionId === "q001");
    expect(first?.judgeUsage?.calls).toBe(3);
    expect(first?.usage?.calls).toBe(2);
    expect(summary.variants[0]?.cost?.judge?.calls).toBe(9);
    expect(summary.variants[1]?.cost?.judge?.calls).toBe(6);
    // the system's cost does not include the judge's
    expect(summary.variants[0]?.cost?.calls).toBe(6);
  });

  it("shows the cost in the report", async () => {
    const { experiment } = await costed();
    const { markdown } = await buildReport({ target: experiment.location });
    expect(markdown).toContain("### Cost per 100 questions");
    expect(markdown).toContain("cost per 100 (USD)");
    expect(markdown).toContain("| `dense` | 13.00 |");
    expect(markdown).toContain("The judge, apart from the system:");
  });

  it("reports tokens but no money when the config has no prices", async () => {
    const experiment = await buildExperiment(
      await options(
        {
          name: "free",
          variants: [{ name: "dense", config: { retrieval: { strategy: "dense" } } }],
        },
        metered,
      ),
    );
    const summary = await experiment.run();
    expect(summary.variants[0]?.cost).toMatchObject({ total: 0, per100Questions: 0 });
    const { markdown } = await buildReport({ target: experiment.location });
    expect(markdown).toContain("No price is set for these models, so no money is shown");
  });
});

describe("buildExperiment: generation", () => {
  it("generates answers, judges them with the judge model, and records tokens", async () => {
    const experiment = await buildExperiment(
      await options({ name: "answers", generation: true, variants: [{ name: "v", config: {} }] }),
    );
    const summary = await experiment.run();
    const saved = await results(experiment.location);

    const cats = saved[0] as QuestionResult;
    expect(cats).toMatchObject({
      answered: true,
      answer: "Cats purr [1].",
      tokens: { prompt: 120, output: 5 },
      models: { generator: "fake:generator", judge: "fake:judge" },
      // one of the two claims is supported; "answers" is 1 and "partial" is 0.5
      generation: { faithfulness: 0.5, relevance: 1, correctness: 0.5 },
    });
    expect(cats.generation?.promptVersions).toHaveLength(3);
    expect(cats.latencyMs.generation).toBeTypeOf("number");
    expect(summary.generation).toBe(true);
    expect(summary.variants[0]?.generation).toMatchObject({ judged: 3, correctness: 0.5 });
  });
});

describe("buildExperiment: problems are reported where they can be fixed", () => {
  it("names a missing experiment file", async () => {
    await expect(
      buildExperiment(await options({ name: "x" }, { file: "nope.json" })),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      message: expect.stringContaining("nope.json") as string,
    });
  });

  it("explains a malformed experiment", async () => {
    await expect(buildExperiment(await options({ name: "x" }))).rejects.toThrow(
      /at least one variant/,
    );
  });

  it("names a variant that does not exist", async () => {
    await expect(
      buildExperiment(
        await options({ name: "x", variants: [{ name: "a", config: {} }] }, { only: ["missing"] }),
      ),
    ).rejects.toThrow(/No variant named "missing".*a/);
  });

  it("says to ingest the book when it is not processed", async () => {
    await expect(
      buildExperiment(
        await options(
          { name: "x", variants: [{ name: "a", config: {} }] },
          { processedDir: path.join(workdir, "empty") },
        ),
      ),
    ).rejects.toThrow(/pnpm ingest/);
  });

  it("names a dataset that cannot be read", async () => {
    await expect(
      buildExperiment(
        await options({
          name: "x",
          dataset: path.join(workdir, "missing.jsonl"),
          variants: [{ name: "a", config: {} }],
        }),
      ),
    ).rejects.toThrow(/missing\.jsonl/);
  });

  it("rejects a dataset whose gold is not in the book", async () => {
    const bad = path.join(workdir, "bad.jsonl");
    await writeFile(
      bad,
      JSON.stringify({
        ...dataset[0],
        gold: [{ page: 1, quote: "words that are not on the page" }],
      }),
    );
    await writeFile(
      path.join(workdir, "bad.meta.json"),
      JSON.stringify({ version: "x", source: { title: "t", sha256: SHA, pageCount: 2 } }),
    );
    await expect(
      buildExperiment(
        await options({ name: "x", dataset: bad, variants: [{ name: "a", config: {} }] }),
      ),
    ).rejects.toThrow(/gold does not resolve/);
  });

  it("creates the folders it needs", async () => {
    await mkdir(path.join(workdir, "results"), { recursive: true });
    const experiment = await buildExperiment(
      await options({ name: "folders", variants: [{ name: "a", config: {} }] }),
    );
    await experiment.run();
    expect(await readdir(experiment.location)).toEqual(
      expect.arrayContaining(["configs", "results.jsonl", "summary.json"]),
    );
  });
});

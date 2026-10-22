import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FileDocumentStore, FileIndexWriter } from "../adapters/index.js";
import { INDEX_MANIFEST_VERSION, makeChunkId } from "../core/index.js";
import type { Chunk, Embedder, IndexContents, ParsedDocument } from "../core/index.js";
import { indexNamespace } from "../pipeline/index.js";
import { makeDocId } from "../shared/index.js";
import { Bm25Index } from "../strategies/index.js";
import { makeDocument } from "../testing/make-document.testing.js";
import { runSmoke } from "./build-smoke.js";
import type { SmokeOptions } from "./build-smoke.js";
import type { EnsureIndex } from "./build-experiment.js";

const SHA = "b".repeat(64);
const DOC = makeDocId(SHA);
const NAMESPACE = indexNamespace("recursive", "ollama:all-minilm");
const CATS = "Cats purr when they are content.";
const DOGS = "Dogs bark at strangers loudly.";
const STOCKS = "Stock markets fell sharply on Monday.";

const unit = (...v: number[]): Float32Array => {
  const length = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return Float32Array.from(v.map((x) => x / length));
};
const CHUNK_DIRECTIONS: Record<string, Float32Array> = {
  [CATS]: unit(1, 0, 0),
  [DOGS]: unit(0.1, 1, 0),
  [STOCKS]: unit(0, 0.1, 1),
};
const QUESTION_DIRECTIONS: Record<string, Float32Array> = {
  "Tell me about cats": unit(1, 0.05, 0),
  "What happened to stock markets": unit(0, 0.05, 1),
};
/** Questions point at their own chunk. */
const goodEmbedder: Embedder = {
  modelId: "ollama:all-minilm",
  dimensions: 3,
  embed: (texts) =>
    Promise.resolve(
      texts.map((t) => CHUNK_DIRECTIONS[t] ?? QUESTION_DIRECTIONS[t] ?? unit(1, 1, 1)),
    ),
};
/** The cats question is sent to the dogs chunk instead: retrieval got worse. */
const brokenEmbedder: Embedder = {
  ...goodEmbedder,
  embed: (texts) =>
    Promise.resolve(
      texts.map((t) =>
        t === "Tell me about cats"
          ? unit(0.1, 1, 0)
          : (CHUNK_DIRECTIONS[t] ?? QUESTION_DIRECTIONS[t] ?? unit(1, 1, 1)),
      ),
    ),
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
      embedder: { modelId: goodEmbedder.modelId, dimensions: 3, batchSize: 32 },
      documents: [DOC],
      counts: { documents: 1, chunks: 3, parents: 0, vectors: 3 },
      timingsMs: { total: 1 },
    },
    chunks,
    vectors: chunks.map((c) => ({
      id: c.id,
      vector: CHUNK_DIRECTIONS[c.text] as Float32Array,
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
];

let workdir: string;
let baselineFile: string;
let experimentFile: string;
let runs = 0;

beforeAll(async () => {
  workdir = await mkdtemp(path.join(tmpdir(), "rag-smoke-"));
  await new FileDocumentStore(path.join(workdir, "processed")).save(document);
  const datasetFile = path.join(workdir, "smoke.jsonl");
  await writeFile(datasetFile, dataset.map((q) => JSON.stringify(q)).join("\n"));
  await writeFile(
    path.join(workdir, "smoke.meta.json"),
    JSON.stringify({
      version: "test-smoke",
      source: { title: "Animals and markets", sha256: SHA, pageCount: 2 },
    }),
  );
  experimentFile = path.join(workdir, "smoke-experiment.json");
  await writeFile(
    experimentFile,
    JSON.stringify({
      name: "smoke",
      dataset: datasetFile,
      generation: false,
      base: { retrieval: { strategy: "dense", k: 1 } },
      variants: [{ name: "default", config: {} }],
    }),
  );
});
afterAll(async () => {
  await rm(workdir, { recursive: true, force: true });
});

function fakeIndexer(): { ensureIndex: EnsureIndex; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    ensureIndex: async ({ indexDir }) => {
      calls += 1;
      await new FileIndexWriter(indexDir).write(indexContents());
      return { namespace: NAMESPACE, status: "built" };
    },
  };
}

function options(extra: Partial<SmokeOptions> = {}): SmokeOptions {
  runs += 1;
  return {
    env: {},
    experimentFile,
    baselineFile,
    processedDir: path.join(workdir, "processed"),
    outDir: path.join(workdir, `results-${runs.toString()}`),
    indexDir: path.join(workdir, "indexes"),
    promptsDir: path.resolve("prompts"),
    embedder: goodEmbedder,
    gitCommit: "abc1234",
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() },
    ensureIndex: fakeIndexer().ensureIndex,
    ...extra,
  };
}

describe("runSmoke", () => {
  it("refuses to run without a baseline, before any model works", async () => {
    baselineFile = path.join(workdir, "missing", "baseline.json");
    const indexer = fakeIndexer();
    await expect(runSmoke(options({ ensureIndex: indexer.ensureIndex }))).rejects.toThrow(
      /no baseline.*--update-baseline/s,
    );
    expect(indexer.calls()).toBe(0);
  });

  it("records a baseline with the recall of every question", async () => {
    baselineFile = path.join(workdir, "recorded", "baseline.json");
    const outcome = await runSmoke(options({ updateBaseline: true }));
    expect(outcome.kind).toBe("recorded");
    const saved = JSON.parse(await readFile(baselineFile, "utf8")) as Record<string, unknown>;
    expect(saved).toMatchObject({
      dataset: "test-smoke",
      k: 1,
      recall: 1,
      questions: { q001: 1, q002: 1 },
      margin: 0.05,
      gitCommit: "abc1234",
    });
  });

  it("keeps the old margin when the baseline is recorded again, and --margin changes it", async () => {
    baselineFile = path.join(workdir, "margin", "baseline.json");
    await runSmoke(options({ updateBaseline: true, margin: 0.2 }));
    await runSmoke(options({ updateBaseline: true }));
    expect(JSON.parse(await readFile(baselineFile, "utf8"))).toMatchObject({ margin: 0.2 });
  });

  it("passes when retrieval is unchanged", async () => {
    baselineFile = path.join(workdir, "pass", "baseline.json");
    await runSmoke(options({ updateBaseline: true }));
    const outcome = await runSmoke(options());
    expect(outcome).toMatchObject({ kind: "checked", report: { verdict: "pass", drop: 0 } });
  });

  it("fails and names the question when retrieval got worse", async () => {
    baselineFile = path.join(workdir, "regress", "baseline.json");
    await runSmoke(options({ updateBaseline: true }));
    const outcome = await runSmoke(options({ embedder: brokenEmbedder }));
    expect(outcome.kind).toBe("checked");
    if (outcome.kind !== "checked") return;
    // the cats question finds the wrong chunk at k = 1: recall (1 + 0) / 2 = 0.5, down 0.5
    expect(outcome.report).toMatchObject({
      verdict: "regression",
      recall: 0.5,
      baselineRecall: 1,
      worse: [{ questionId: "q001", before: 1, after: 0 }],
    });
  });

  it("lets a wide margin tolerate the same drop", async () => {
    baselineFile = path.join(workdir, "wide", "baseline.json");
    await runSmoke(options({ updateBaseline: true }));
    const outcome = await runSmoke(options({ embedder: brokenEmbedder, margin: 0.5 }));
    expect(outcome).toMatchObject({ kind: "checked", report: { verdict: "pass" } });
  });

  it("rejects a baseline file that is not valid", async () => {
    baselineFile = path.join(workdir, "bad-baseline.json");
    await writeFile(baselineFile, JSON.stringify({ recall: 2 }));
    await expect(runSmoke(options())).rejects.toThrow(/baseline .* is not valid/);
  });
});

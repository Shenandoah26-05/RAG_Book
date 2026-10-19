import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FileIndexWriter } from "../adapters/index.js";
import { INDEX_MANIFEST_VERSION, makeChunkId } from "../core/index.js";
import type { Chunk, Embedder, IndexContents, LlmProvider } from "../core/index.js";
import { indexNamespace, readAnswer } from "../pipeline/index.js";
import { makeDocId } from "../shared/index.js";
import { Bm25Index } from "../strategies/index.js";
import { buildPipeline, PROMPT_FILE } from "./build-pipeline.js";
import type { BuildPipelineOptions } from "./build-pipeline.js";

const DOC = makeDocId("d".repeat(64));
const NAMESPACE = indexNamespace("recursive", "ollama:all-minilm");

const unit = (...v: number[]): Float32Array => {
  const length = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return Float32Array.from(v.map((x) => x / length));
};

const QUESTION = "Tell me about cats";
/** Texts map to fixed directions: the question points at the cat chunks. */
const DIRECTIONS: Record<string, Float32Array> = {
  [QUESTION]: unit(1, 0.1, 0),
  "Cats purr when they are content.": unit(1, 0.1, 0),
  "Cats sleep for most of the day.": unit(0.9, 0.3, 0),
  "Dogs bark at strangers.": unit(0.1, 1, 0),
  "Stock markets fell sharply.": unit(0, 0.1, 1),
};
const embedder: Embedder = {
  modelId: "ollama:all-minilm",
  dimensions: 3,
  embed: (texts) => Promise.resolve(texts.map((t) => DIRECTIONS[t] ?? unit(1, 1, 1))),
};

function chunk(text: string, start: number, parentId?: Chunk["id"]): Chunk {
  return {
    id: makeChunkId({
      docId: DOC,
      strategy: "recursive",
      charStart: start,
      charEnd: start + text.length,
      text,
    }),
    text,
    ...(parentId === undefined ? {} : { parentId }),
    metadata: {
      docId: DOC,
      pageStart: Math.floor(start / 100) + 1,
      pageEnd: Math.floor(start / 100) + 1,
      sectionPath: [],
      charStart: start,
      charEnd: start + text.length,
      strategy: "recursive",
    },
  };
}

const texts = Object.keys(DIRECTIONS).filter((t) => t !== QUESTION);
const chunks = texts.map((text, i) => chunk(text, i * 100));

function contents(options: { keyword?: boolean; parents?: boolean } = {}): IndexContents {
  const { keyword = true, parents = false } = options;
  const all = parents ? [...chunks, chunk("A whole chapter about animals.", 900)] : chunks;
  const keywordIndex = new Bm25Index();
  keywordIndex.add(chunks);
  return {
    manifest: {
      version: INDEX_MANIFEST_VERSION,
      namespace: NAMESPACE,
      createdAt: "2026-10-19T10:00:00.000Z",
      gitCommit: null,
      configHash: "c".repeat(64),
      fingerprint: "f".repeat(64),
      chunker: { name: "recursive", tokenizer: "approx", maxTokens: 400, overlapTokens: 60 },
      embedder: { modelId: embedder.modelId, dimensions: 3, batchSize: 32 },
      documents: [DOC],
      counts: {
        documents: 1,
        chunks: all.length,
        parents: all.length - chunks.length,
        vectors: chunks.length,
      },
      timingsMs: { total: 1 },
    },
    chunks: all,
    vectors: chunks.map((c) => ({
      id: c.id,
      vector: DIRECTIONS[c.text] as Float32Array,
      metadata: c.metadata,
    })),
    ...(keyword ? { keywordIndex: keywordIndex.serialize() } : {}),
  };
}

const llm: LlmProvider = {
  modelId: "fake:llm",
  async *chat() {
    await Promise.resolve();
    yield { kind: "text", text: "Cats purr [1]." } as const;
    yield { kind: "end", reason: "stop" } as const;
  },
};

let workdir: string;
let promptsDir: string;
const indexDirs: string[] = [];

beforeAll(async () => {
  workdir = await mkdtemp(path.join(tmpdir(), "rag-build-pipeline-"));
  promptsDir = path.join(workdir, "prompts");
  // the real prompt, so a change to the file is exercised here too
  const { mkdir } = await import("node:fs/promises");
  await mkdir(promptsDir);
  await writeFile(
    path.join(promptsDir, PROMPT_FILE),
    await readFile(path.resolve("prompts", PROMPT_FILE), "utf8"),
  );
});
afterAll(async () => {
  await rm(workdir, { recursive: true, force: true });
});

/** Saves an index into a fresh folder and returns options that point a pipeline at it. */
async function setup(
  index: IndexContents | undefined,
  argv: readonly string[] = [],
): Promise<BuildPipelineOptions> {
  const indexDir = path.join(workdir, `index-${indexDirs.length.toString()}`);
  indexDirs.push(indexDir);
  if (index !== undefined) await new FileIndexWriter(indexDir).write(index);
  return { argv, env: {}, indexDir, promptsDir, embedder, llm };
}

describe("buildPipeline", () => {
  it("builds a pipeline from the default configuration and answers from the saved index", async () => {
    const pipeline = await buildPipeline(await setup(contents()));
    expect(pipeline.describe()).toEqual({
      transformer: "identity",
      retriever: "hybrid",
      reranker: "noop",
      llm: "fake:llm",
    });

    const answer = await pipeline.ask(QUESTION, { k: 2 });
    expect(await readAnswer(answer)).toBe("Cats purr [1].");
    expect(answer.prompt.included.map((c) => c.chunk.text).sort()).toEqual([
      "Cats purr when they are content.",
      "Cats sleep for most of the day.",
    ]);
    expect(answer.prompt.system).toContain("Cats purr when they are content.");
    expect(answer.prompt.promptVersion).toBe("rag-system@v1");
    expect(answer.citations).toHaveLength(2);
    expect(answer.trace.snapshot().stages.map((s) => s.stage)).toEqual([
      "transform",
      "retrieve",
      "rerank",
      "assemble",
      "generate",
    ]);
  });

  it("uses retrieval.strategy from the configuration", async () => {
    const dense = await buildPipeline(await setup(contents(), ["--retrieval.strategy=dense"]));
    expect(dense.describe().retriever).toBe("dense");
    const bm25 = await buildPipeline(await setup(contents(), ["--retrieval.strategy=bm25"]));
    expect(bm25.describe().retriever).toBe("bm25");
  });

  it("works with a dense retriever when the index has no keyword index", async () => {
    const options = await setup(contents({ keyword: false }), ["--retrieval.strategy=dense"]);
    const answer = await (await buildPipeline(options)).ask(QUESTION, { k: 1 });
    expect(answer.prompt.included).toHaveLength(1);
  });

  it("explains how to fix an index with no keyword index when keyword search is needed", async () => {
    const options = await setup(contents({ keyword: false }));
    await expect(buildPipeline(options)).rejects.toThrow(/no keyword index.*pnpm index --force/s);
  });

  it("expands to parents when the index has them", async () => {
    const pipeline = await buildPipeline(await setup(contents({ parents: true })));
    expect(pipeline.describe().retriever).toBe("hybrid+parents");
  });

  it("fetches rerank.candidates and uses the reranker named in the configuration", async () => {
    const options = await setup(contents(), [
      "--rerank.enabled=true",
      "--rerank.strategy=noop",
      "--rerank.candidates=6",
    ]);
    const answer = await (await buildPipeline(options)).ask(QUESTION, { k: 1 });
    const stages = Object.fromEntries(answer.trace.stages.map((s) => [s.stage, s.summary]));
    expect(stages["retrieve"]).toMatchObject({ found: 4 });
    expect(stages["rerank"]).toMatchObject({ reranker: "noop", candidates: 4, kept: 1 });
  });

  it("builds the llm reranker from the generation model when rerank.strategy is llm", async () => {
    // the default strategy is "llm": turning reranking on must be enough, with no extra setup
    const pipeline = await buildPipeline(await setup(contents(), ["--rerank.enabled=true"]));
    expect(pipeline.describe()).toMatchObject({ reranker: "llm", llm: "fake:llm" });
  });

  it("fetches only k when reranking is off", async () => {
    const answer = await (await buildPipeline(await setup(contents()))).ask(QUESTION, { k: 2 });
    const retrieve = answer.trace.stages.find((s) => s.stage === "retrieve");
    expect(retrieve?.summary).toMatchObject({ found: 2 });
  });
});

describe("buildPipeline: problems are reported where they can be fixed", () => {
  it("says to run pnpm index when there is no index", async () => {
    const options = await setup(undefined);
    const error = await buildPipeline(options).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "INVALID_ARGUMENT" });
    expect((error as Error).message).toContain(NAMESPACE);
    expect((error as Error).message).toContain('"pnpm index"');
  });

  it.each([
    [["--retrieval.strategy=nope"], "Unknown retriever", "dense"],
    [["--retrieval.fusion=nope"], "Unknown fusion", "rrf"],
    [["--rerank.enabled=true", "--rerank.strategy=nope"], "Unknown reranker", "cross-encoder"],
    [["--generation.ordering=nope"], "Unknown ordering", "sandwich"],
  ])("rejects %j as CONFIG_INVALID and lists what exists", async (flags, message, known) => {
    const options = await setup(contents(), flags);
    const error = await buildPipeline(options).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "CONFIG_INVALID" });
    expect((error as Error).message).toContain(message);
    expect((error as Error).message).toContain(known);
  });

  it("names the prompt file it cannot read", async () => {
    const options = await setup(contents());
    await expect(buildPipeline({ ...options, promptsDir: workdir })).rejects.toMatchObject({
      code: "CONFIG_INVALID",
      message: expect.stringContaining(PROMPT_FILE) as string,
    });
  });
});

// The acceptance criterion "constructed only in composition/build-pipeline.ts", kept true by a test.
describe("RagPipeline construction", () => {
  const srcDir = path.resolve(import.meta.dirname, "..");

  async function sourceFiles(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    const nested = await Promise.all(
      entries.map(async (entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return sourceFiles(full);
        return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [full] : [];
      }),
    );
    return nested.flat();
  }

  it("happens only in composition/build-pipeline.ts", async () => {
    const files = await sourceFiles(srcDir);
    const texts = await Promise.all(files.map((file) => readFile(file, "utf8")));
    const builders = files
      .filter((_, i) => /new RagPipeline\(/.test(texts[i] ?? ""))
      .map((file) => path.relative(srcDir, file).split(path.sep).join("/"));
    expect(builders).toEqual(["composition/build-pipeline.ts"]);
  });
});

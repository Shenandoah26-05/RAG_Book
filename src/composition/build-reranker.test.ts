import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../config/index.js";
import type {
  ChatDelta,
  LlmProvider,
  Query,
  RetrieveOptions,
  RetrievedChunk,
  Retriever,
} from "../core/index.js";
import { RagError } from "../shared/index.js";
import { LlmReranker, NoopReranker, RerankingRetriever } from "../strategies/index.js";
import { makeCandidates } from "../testing/reranker-contract.testing.js";
import {
  buildReranker,
  buildRerankingRetriever,
  rerankerNames,
  resolveRerank,
} from "./build-reranker.js";

const off = DEFAULT_CONFIG.rerank;
const on = { ...off, enabled: true, strategy: "noop", candidates: 4 };

class Recording implements Retriever {
  readonly name = "dense";
  readonly calls: RetrieveOptions[] = [];
  retrieve(_query: Query, options: RetrieveOptions): Promise<readonly RetrievedChunk[]> {
    this.calls.push(options);
    return Promise.resolve(makeCandidates(["a", "b", "c", "d", "e"]).slice(0, options.k));
  }
}

describe("buildReranker", () => {
  it("knows the noop reranker by its config name", () => {
    expect(rerankerNames()).toEqual(["noop", "llm"]);
  });

  it("is the no-op reranker for the default configuration, where reranking is off", () => {
    expect(DEFAULT_CONFIG.rerank.enabled).toBe(false);
    expect(buildReranker(DEFAULT_CONFIG.rerank)).toBeInstanceOf(NoopReranker);
  });

  it("is the no-op reranker when off, whatever the strategy names", () => {
    expect(buildReranker({ ...off, strategy: "does-not-exist" })).toBeInstanceOf(NoopReranker);
  });

  it("builds the reranker named in rerank.strategy when on", () => {
    expect(buildReranker(on)).toBeInstanceOf(NoopReranker);
  });

  it("says which rerankers exist when the strategy is unknown", () => {
    const error = (() => {
      try {
        buildReranker({ ...on, strategy: "cross-encoder" });
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(RagError);
    expect((error as RagError).code).toBe("CONFIG_INVALID");
    expect((error as RagError).message).toContain(
      'Unknown reranker "cross-encoder" in rerank.strategy',
    );
    expect((error as RagError).message).toContain("noop, llm");
  });
});

describe("resolveRerank", () => {
  it("asks for no extra candidates when off, and rerank.candidates when on", () => {
    expect(resolveRerank(off).candidates).toBe(0);
    expect(resolveRerank(on).candidates).toBe(4);
  });
});

describe("buildRerankingRetriever", () => {
  it("is a RerankingRetriever with the wrapped retriever's name, on or off", () => {
    for (const settings of [off, on]) {
      const retriever = buildRerankingRetriever(new Recording(), settings);
      expect(retriever).toBeInstanceOf(RerankingRetriever);
      expect(retriever.name).toBe("dense");
    }
  });

  it("fetches only k and returns them unchanged when off", async () => {
    const inner = new Recording();
    const results = await buildRerankingRetriever(inner, off).retrieve({ text: "q" }, { k: 2 });
    expect(inner.calls).toEqual([{ k: 2 }]);
    expect(results.map((r) => r.chunk.text)).toEqual(["a", "b"]);
  });

  it("fetches rerank.candidates and returns k when on", async () => {
    const inner = new Recording();
    const results = await buildRerankingRetriever(inner, on).retrieve({ text: "q" }, { k: 2 });
    expect(inner.calls).toEqual([{ k: 4 }]);
    expect(results.map((r) => r.chunk.text)).toEqual(["a", "b"]);
  });
});

// The acceptance criterion "grep shows no rerank flag checks outside composition/", kept true by a
// test. The config module defines and validates the settings, so it may mention them too.
describe("the rerank flag", () => {
  const srcDir = path.resolve(import.meta.dirname, "..");
  const allowed = [`${path.sep}composition${path.sep}`, `${path.sep}config${path.sep}`];

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(full);
      return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [full] : [];
    });
  }

  it("is read only in composition/ and config/", () => {
    const readers = sourceFiles(srcDir)
      .filter((file) => !allowed.some((dir) => file.includes(dir)))
      .filter((file) =>
        /\brerank\??\.(enabled|strategy|candidates)\b/.test(readFileSync(file, "utf8")),
      )
      .map((file) => path.relative(srcDir, file));
    expect(readers).toEqual([]);
  });
});

// ---- the "llm" reranker (RAG-061) ---------------------------------------------------------------

const llmOn = { ...off, enabled: true, strategy: "llm", candidates: 4, concurrency: 2 };

/** A fetch that plays Ollama: reads the prompt and answers with a score for the passage in it. */
function fakeOllama(scores: Record<string, number>): typeof fetch & { bodies: unknown[] } {
  const bodies: unknown[] = [];
  const fn = vi.fn<typeof fetch>((_url, init) => {
    const body = JSON.parse(init?.body as string) as { messages: { content: string }[] };
    bodies.push(body);
    const prompt = body.messages[0]?.content ?? "";
    const hit = Object.entries(scores).find(([text]) => prompt.includes(`\n${text}\n`));
    const lines = [
      { message: { content: JSON.stringify({ score: hit?.[1] ?? 0 }) } },
      { done: true, done_reason: "stop" },
    ];
    return Promise.resolve(new Response(lines.map((l) => `${JSON.stringify(l)}\n`).join("")));
  });
  return Object.assign(fn, { bodies });
}

describe("buildReranker: llm", () => {
  it("builds an LlmReranker when rerank.strategy is llm and a model is given", () => {
    const reranker = buildReranker(llmOn, { generation: DEFAULT_CONFIG.generation });
    expect(reranker).toBeInstanceOf(LlmReranker);
    expect(reranker.name).toBe("llm");
  });

  it("uses a provider it is handed instead of building one", async () => {
    const llm: LlmProvider = {
      modelId: "fake:judge",
      chat: () =>
        (async function* (): AsyncGenerator<ChatDelta> {
          await Promise.resolve();
          yield { kind: "text", text: '{"score": 6}' };
          yield { kind: "end", reason: "stop" };
        })(),
    };
    const results = await buildReranker(llmOn, { llm }).rerank(
      { text: "q" },
      makeCandidates(["a", "b"]),
      { k: 2 },
    );
    expect(results.map((r) => r.score)).toEqual([6, 6]);
  });

  it("says what is missing when there is no model to build it from", () => {
    expect(() => buildReranker(llmOn)).toThrow(RagError);
    expect(() => buildReranker(llmOn)).toThrow(/needs a language model/);
  });

  it("says where the prompt should be when the file is missing", () => {
    expect(() =>
      buildReranker(llmOn, {
        generation: DEFAULT_CONFIG.generation,
        promptsDir: path.join(import.meta.dirname, "no-such-folder"),
      }),
    ).toThrow(/Cannot read the rerank prompt .*rerank-relevance\.v1\.txt/);
  });

  it("is not built, and needs no model, while reranking is off", () => {
    expect(buildReranker({ ...llmOn, enabled: false })).toBeInstanceOf(NoopReranker);
  });

  it("reranks through a real OllamaProvider using the generation model, one request per chunk", async () => {
    const ollama = fakeOllama({ "second chunk": 9, "third chunk": 4 });
    const inner = makeCandidates(["first chunk", "second chunk", "third chunk"]);
    const results = await buildReranker(llmOn, {
      generation: { ...DEFAULT_CONFIG.generation, model: "qwen2.5" },
      env: { OLLAMA_HOST: "gpu-box:9000" },
      fetch: ollama,
    }).rerank({ text: "Which is best?" }, inner, { k: 2 });

    expect(results.map((r) => r.chunk.text)).toEqual(["second chunk", "third chunk"]);
    expect(results.map((r) => r.score)).toEqual([9, 4]);
    expect(ollama.bodies).toHaveLength(3);
    const first = ollama.bodies[0] as {
      model: string;
      stream: boolean;
      options: { temperature: number; num_predict: number };
      messages: { role: string; content: string }[];
    };
    expect(first.model).toBe("qwen2.5");
    expect(first.options).toEqual({ temperature: 0, num_predict: 60 });
    expect(first.messages[0]?.role).toBe("user");
    expect(first.messages[0]?.content).toContain("Which is best?");
    expect(first.messages[0]?.content).toContain("first chunk");
  });

  it("fetches rerank.candidates and returns k, with the model's order", async () => {
    const ollama = fakeOllama({ d: 10, c: 7, b: 1 });
    const inner = new Recording();
    const results = await buildRerankingRetriever(inner, llmOn, {
      generation: DEFAULT_CONFIG.generation,
      fetch: ollama,
    }).retrieve({ text: "q" }, { k: 2 });
    expect(inner.calls).toEqual([{ k: 4 }]);
    expect(results.map((r) => r.chunk.text)).toEqual(["d", "c"]);
    expect(results.map((r) => r.rank)).toEqual([1, 2]);
  });

  it("falls back to the retriever's order when Ollama cannot be reached", async () => {
    const down = vi.fn<typeof fetch>(() => Promise.reject(new TypeError("fetch failed")));
    const inner = new Recording();
    const results = await buildRerankingRetriever(inner, llmOn, {
      generation: DEFAULT_CONFIG.generation,
      fetch: down,
    }).retrieve({ text: "q" }, { k: 2 });
    expect(results.map((r) => r.chunk.text)).toEqual(["a", "b"]);
  });
});

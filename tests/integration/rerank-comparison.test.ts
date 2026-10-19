import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildSearcher, describeSearch } from "../../src/composition/index.js";
import type { SearchReport } from "../../src/composition/index.js";
import {
  cars,
  DIMENSIONS,
  dogs,
  furry,
  purr,
  writeFixtureIndex,
  young,
} from "../../src/composition/search-fixture.testing.js";
import type { Logger } from "../../src/shared/index.js";
import { noopLogger } from "../../src/shared/index.js";

// RAG-063: the rerank flag does what it says. The reranker itself is tested elsewhere; this tests
// the wiring from the configuration (the real rag.config.json, a variant file, a flag) to what a
// search does, and what the retrieval trace shows of it.

const QUESTION = "cats";

/**
 * What the judge thinks of each passage. It is deliberately not the order retrieval gives: the
 * chunk that comes third from retrieval is the judge's favourite, so reranking has to reach past
 * `k` and put it first.
 */
const JUDGE: Readonly<Record<string, number>> = {
  [furry.text]: 10,
  [purr.text]: 8,
  [young.text]: 3,
  [dogs.text]: 2,
  [cars.text]: 0,
};

interface ChatBody {
  readonly model: string;
  readonly messages: readonly { readonly content: string }[];
}

interface FakeOllama {
  readonly fetch: typeof fetch;
  /** The requests the judge received, in order. */
  readonly judged: ChatBody[];
  /** How many questions were embedded. */
  readonly embedded: () => number;
}

const urlOf = (input: Parameters<typeof fetch>[0]): string =>
  typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

/**
 * Stands in for an Ollama server. `/api/embed` gives every question the direction the fixture's
 * chunks lean to; `/api/chat` is the judge, who reads the passage in the prompt and answers with
 * its score from `JUDGE`. With `judgeDown`, the judge is unreachable.
 */
function fakeOllama(options: { judgeDown?: boolean } = {}): FakeOllama {
  const judged: ChatBody[] = [];
  let embeddings = 0;
  const fn = vi.fn<typeof fetch>((url, init) => {
    const body = JSON.parse(init?.body as string) as ChatBody & { input?: string[] };
    if (urlOf(url).endsWith("/api/embed")) {
      embeddings += body.input?.length ?? 0;
      const vector = Array.from({ length: DIMENSIONS }, (_, i) => (i === 0 ? 1 : 0));
      return Promise.resolve(new Response(JSON.stringify({ embeddings: [vector] })));
    }
    judged.push(body);
    if (options.judgeDown === true) return Promise.reject(new TypeError("fetch failed"));
    const prompt = body.messages[0]?.content ?? "";
    const passage = Object.keys(JUDGE).find((text) => prompt.includes(`"""\n${text}\n"""`));
    const lines = [
      {
        message: { content: JSON.stringify({ score: passage === undefined ? 0 : JUDGE[passage] }) },
      },
      { done: true, done_reason: "stop" },
    ];
    return Promise.resolve(new Response(lines.map((l) => `${JSON.stringify(l)}\n`).join("")));
  });
  return { fetch: fn, judged, embedded: () => embeddings };
}

/** A report with the numbers that change from run to run removed, so it can be compared and snapshotted. */
function withoutTimings(report: SearchReport): SearchReport {
  const byName = <T extends { name: string }>(a: T, b: T): number => a.name.localeCompare(b.name);
  return {
    ...report,
    totalMs: 0,
    index: { ...report.index, loadMs: 0, location: "<index folder>" },
    // the retrievers of a hybrid run side by side, so which one reports first is not fixed
    retrievers: report.retrievers.map((r) => ({ ...r, startMs: 0, durationMs: 0 })).sort(byName),
    stages: report.stages
      .map((s) => ({ ...s, startMs: 0, durationMs: 0 }))
      .sort((a, b) => a.stage.localeCompare(b.stage)),
  };
}

const texts = (list: readonly { chunk: { text: string } }[]): string[] =>
  list.map((r) => r.chunk.text);

describe("rerank.enabled false and true, same query", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "rag-rerank-e2e-"));
    await writeFixtureIndex(path.join(dir, "index"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** One search. `variant` and `argv` are how a person would turn reranking on. */
  async function search(
    ollama: FakeOllama,
    how: { variant?: string; argv?: string[]; logger?: Logger } = {},
  ): Promise<SearchReport> {
    const searcher = await buildSearcher({
      env: {},
      argv: how.argv ?? [],
      indexDir: path.join(dir, "index"),
      cacheDir: path.join(dir, "cache"),
      logger: how.logger ?? noopLogger,
      fetch: ollama.fetch,
      ...(how.variant === undefined ? {} : { variant: how.variant }),
    });
    return searcher.search(QUESTION, { k: 2 });
  }

  describe("off (the default configuration)", () => {
    it("keeps the retriever's order, asks the judge nothing, and the trace shows one order", async () => {
      const ollama = fakeOllama();
      const report = await search(ollama);

      expect(report.settings.rerank.enabled).toBe(false);
      expect(texts(report.results)).toEqual([young.text, purr.text]);
      expect(ollama.judged).toHaveLength(0);
      // the no-op reranker changes nothing, so what it was given is what comes out
      expect(report.candidates).toEqual(report.results);
    });
  });

  describe("on", () => {
    it("reorders the candidates with the judge's scores and reaches past k", async () => {
      const ollama = fakeOllama();
      const report = await search(ollama, { variant: "rerank-llm" });

      expect(report.settings.rerank).toEqual({ enabled: true, strategy: "llm" });
      // the retriever's order, with all five candidates fetched although k is 2
      expect(texts(report.candidates)).toEqual([
        young.text,
        purr.text,
        furry.text,
        dogs.text,
        cars.text,
      ]);
      // the judge's order: its favourite was third, outside k, and is now first
      expect(texts(report.results)).toEqual([furry.text, purr.text]);
      expect(report.results.map((r) => r.score)).toEqual([10, 8]);
      expect(report.results.map((r) => r.rank)).toEqual([1, 2]);
      // each result still says which retriever found it
      expect(report.results.every((r) => r.retriever === "hybrid")).toBe(true);
    });

    it("asks the generation model, once for each candidate, about the question and the passage", async () => {
      const ollama = fakeOllama();
      await search(ollama, { variant: "rerank-llm" });

      expect(ollama.judged).toHaveLength(5);
      for (const request of ollama.judged) {
        expect(request.model).toBe("llama3.2");
        const prompt = request.messages[0]?.content ?? "";
        expect(prompt).toContain(`Question:\n${QUESTION}`);
      }
      const passages = ollama.judged.map((r) =>
        Object.keys(JUDGE).find((t) => r.messages[0]?.content.includes(`"""\n${t}\n"""`)),
      );
      expect(new Set(passages)).toEqual(new Set(Object.keys(JUDGE)));
    });

    it("is turned on by a flag as well as by a variant", async () => {
      const report = await search(fakeOllama(), {
        argv: ["--rerank.enabled=true", "--rerank.candidates=5"],
      });
      expect(texts(report.results)).toEqual([furry.text, purr.text]);
    });

    it("fetches only rerank.candidates chunks", async () => {
      const ollama = fakeOllama();
      const report = await search(ollama, {
        argv: ["--rerank.enabled=true", "--rerank.candidates=3", "--retrieval.k=2"],
      });
      expect(texts(report.candidates)).toEqual([young.text, purr.text, furry.text]);
      expect(ollama.judged).toHaveLength(3);
      // dogs and cars were never fetched, so the judge never saw them
      expect(texts(report.results)).toEqual([furry.text, purr.text]);
    });
  });

  describe("the two runs side by side", () => {
    it("retrieve exactly the same thing: reranking changes only what comes after", async () => {
      const off = await search(fakeOllama());
      const on = await search(fakeOllama(), { variant: "rerank-llm" });

      const lists = (report: SearchReport) =>
        report.retrievers
          .map((r) => ({ name: r.name, hits: r.results.map((h) => [h.chunk.id, h.score]) }))
          .sort((a, b) => a.name.localeCompare(b.name));
      // dense and bm25 each found the same chunks with the same scores
      expect(lists(on).map((l) => l.name)).toEqual(["bm25", "dense"]);
      expect(lists(on)).toEqual(lists(off));
      // what reranking was given begins with exactly what the off run returned
      expect(on.candidates.slice(0, 2)).toEqual(off.results);
    });

    it("differ in the order of the results and nothing else about the settings", async () => {
      const off = await search(fakeOllama());
      const on = await search(fakeOllama(), { variant: "rerank-llm" });
      expect(texts(off.results)).not.toEqual(texts(on.results));
      expect({ ...off.settings, rerank: undefined }).toEqual({ ...on.settings, rerank: undefined });
      expect([off.settings.rerank.enabled, on.settings.rerank.enabled]).toEqual([false, true]);
    });
  });

  describe("when the judge cannot be reached", () => {
    it("falls back to the retriever's order, and says so in the log", async () => {
      const warnings: string[] = [];
      const logger: Logger = {
        ...noopLogger,
        warn: (message: string) => warnings.push(message),
      };
      const ollama = fakeOllama({ judgeDown: true });
      const report = await search(ollama, { variant: "rerank-llm", logger });

      // never worse than not reranking: the first k of what retrieval found
      expect(texts(report.results)).toEqual([young.text, purr.text]);
      expect(texts(report.results)).toEqual(texts(report.candidates.slice(0, 2)));
      expect(warnings.some((w) => w.includes("llm rerank failed"))).toBe(true);
    });
  });

  describe("the trace, as a snapshot", () => {
    it("with reranking off", async () => {
      const report = withoutTimings(await search(fakeOllama()));
      expect(describeSearch(report)).toMatchSnapshot();
    });

    it("with reranking on, showing the order before and after", async () => {
      const report = withoutTimings(await search(fakeOllama(), { variant: "rerank-llm" }));
      expect(describeSearch(report)).toMatchSnapshot();
    });

    it("the stages of the trace, in both cases", async () => {
      const stages = async (variant?: string) =>
        withoutTimings(await search(fakeOllama(), variant === undefined ? {} : { variant })).stages;
      expect({
        off: await stages(),
        on: await stages("rerank-llm"),
      }).toMatchSnapshot();
    });
  });
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileIndexReader } from "../adapters/index.js";
import { DEFAULT_CONFIG } from "../config/index.js";
import type { ChunkId, Embedder, RetrievedChunk, Retriever } from "../core/index.js";
import {
  DIMENSIONS,
  NAMESPACE,
  QUESTION_VECTOR,
  dogs,
  furry,
  purr,
  writeFixtureIndex,
  young,
} from "./search-fixture.testing.js";
import {
  buildRetriever,
  fusionNames,
  retrievalStrategyNames,
  usesEmbedder,
} from "./build-retriever.js";
import { loadIndex } from "./load-index.js";
import { buildRerankingRetriever } from "./build-reranker.js";
import { buildRetriever, fusionNames, retrieverNames, usesEmbedder } from "./build-retriever.js";
import { openIndex } from "./load-index.js";
import type { LoadedIndex } from "./load-index.js";

const embedder: Embedder = {
  modelId: "ollama:all-minilm",
  dimensions: DIMENSIONS,
  embed: (texts) => Promise.resolve(texts.map(() => QUESTION_VECTOR)),
};
const ask = { text: "cats" };
const texts = (results: readonly RetrievedChunk[]): string[] => results.map((r) => r.chunk.text);

describe("buildRetriever", () => {
  let root: string;
  beforeEach(async () => {
    root = path.join(await mkdtemp(path.join(tmpdir(), "rag-build-retriever-")), "index");
  });
  afterEach(async () => {
    await rm(path.dirname(root), { recursive: true, force: true });
  });

  const load = async (
    options: Parameters<typeof writeFixtureIndex>[1] = {},
  ): Promise<LoadedIndex> => {
    await writeFixtureIndex(root, options);
    return openIndex(new FileIndexReader(root), NAMESPACE, DEFAULT_CONFIG.vectorStore);
  };
  const build = (
    index: LoadedIndex,
    retrieval: Partial<typeof DEFAULT_CONFIG.retrieval>,
    wrap?: (r: Retriever) => Retriever,
  ) =>
    buildRetriever(
      { ...DEFAULT_CONFIG.retrieval, ...retrieval },
      { index, embedder, ...(wrap === undefined ? {} : { wrap }) },
    );

  it("knows the strategies, the fusions, and which strategies need the embedder", () => {
    expect(retrieverNames()).toEqual(["dense", "bm25", "hybrid"]);
    expect(fusionNames()).toEqual(["rrf", "weighted"]);
    expect(["dense", "hybrid"].every(usesEmbedder)).toBe(true);
    expect(usesEmbedder("bm25")).toBe(false);
    expect(usesEmbedder("magic")).toBe(false);
  });

  it("builds a dense retriever over the vectors", async () => {
    const retriever = build(await load(), { strategy: "dense" });
    expect(retriever.name).toBe("dense");
    expect((await retriever.retrieve(ask, { k: 2 })).map((r) => r.chunk)).toEqual([young, dogs]);
  });

  it("builds a bm25 retriever over the keyword index, which needs no embedder", async () => {
    const retriever = buildRetriever(
      { ...DEFAULT_CONFIG.retrieval, strategy: "bm25" },
      { index: await load() },
    );
    expect(retriever.name).toBe("bm25");
    expect(texts(await retriever.retrieve(ask, { k: 5 }))).toEqual([
      purr.text,
      young.text,
      furry.text,
    ]);
  });

  it.each(["rrf", "weighted"])("builds a hybrid of both with %s fusion", async (fusion) => {
    const retriever = build(await load(), { strategy: "hybrid", fusion });
    expect(retriever.name).toBe("hybrid");
    const results = await retriever.retrieve(ask, { k: 5 });
    expect(results.every((r) => r.retriever === "hybrid")).toBe(true);
    // found by words only (purr) and by meaning only (dogs), so both retrievers took part
    expect(texts(results)).toEqual(expect.arrayContaining([purr.text, dogs.text]));
  });

  it("wraps only the base retrievers, so a hybrid reports dense and bm25 separately", async () => {
    const names: string[] = [];
    const retriever = build(await load(), { strategy: "hybrid" }, (inner) => {
      names.push(inner.name);
      return inner;
    });
    expect(names).toEqual(["dense", "bm25"]);
    expect(retriever.name).toBe("hybrid");
  });

  it("expands children to parents only when the index has parents", async () => {
    const plain = build(await load(), { strategy: "dense" });
    expect(plain.name).toBe("dense");

    const parent = { ...furry, id: "parent-1" as ChunkId, text: "A whole chapter about cats." };
    const withParents = await load({ parents: [parent] });
    expect(withParents.hasParents).toBe(true);
    expect(build(withParents, { strategy: "dense" }).name).toBe("dense+parents");
  });

  it("applies the reranking settings (the no-op reranker keeps the order)", async () => {
    const index = await load();
    const retriever = buildRetriever({
      retrieval: { ...DEFAULT_CONFIG.retrieval, strategy: "dense" },
      rerank: { enabled: true, strategy: "noop", candidates: 4, concurrency: 4 },
      index,
      embedder,
  it("leaves reranking to buildRerankingRetriever, which wraps what this builds", async () => {
    const base = build(await load(), { strategy: "dense" });
    const reranking = buildRerankingRetriever(base, {
      ...DEFAULT_CONFIG.rerank,
      enabled: true,
      strategy: "noop",
      candidates: 4,
    });
    expect(reranking.name).toBe("dense");
    expect((await reranking.retrieve(ask, { k: 2 })).map((r) => r.chunk)).toEqual([young, dogs]);
  });

  describe("errors", () => {
    it("names the strategies and fusions that exist for an unknown one", async () => {
      const index = await load();
      expect(() => build(index, { strategy: "magic" })).toThrow(
        /Unknown retriever "magic".*Known retrievers: dense, bm25, hybrid/,
      );
      expect(() => build(index, { strategy: "hybrid", fusion: "magic" })).toThrow(
        /Known fusions: rrf, weighted/,
      );
    });

    it("says to rebuild when keyword search is asked of an index without a keyword index", async () => {
      const index = await load({ withKeyword: false });
      for (const strategy of ["bm25", "hybrid"]) {
        expect(() => build(index, { strategy })).toThrow(/no keyword index.*pnpm index --force/s);
      }
      // dense still works
      expect(build(index, { strategy: "dense" }).name).toBe("dense");
    });

    it("needs an embedder for dense and hybrid", async () => {
      const index = await load();
      for (const strategy of ["dense", "hybrid"]) {
        expect(() => buildRetriever({ ...DEFAULT_CONFIG.retrieval, strategy }, { index })).toThrow(
          /needs an embedder/,
        );
      }
    });
  });
});

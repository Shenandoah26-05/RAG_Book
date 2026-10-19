import { describe, expect, it } from "vitest";
import type { RetrievedChunk } from "../core/index.js";
import { dogs, furry, purr, young } from "./search-fixture.testing.js";
import type { SearchReport } from "./build-searcher.js";
import { describeFilter, describeSearch, searchToJson } from "./search-summary.js";

const hit = (
  chunk: RetrievedChunk["chunk"],
  rank: number,
  score: number,
  retriever: string,
): RetrievedChunk => ({
  chunk,
  rank,
  score,
  retriever,
});

const dense = [hit(young, 1, 0.9912, "dense"), hit(dogs, 2, 0.8, "dense")];
const bm25 = [hit(purr, 1, 1.3486, "bm25"), hit(furry, 2, 0.5442, "bm25")];

const report = (overrides: Partial<SearchReport> = {}): SearchReport => ({
  question: "cats",
  k: 2,
  filter: [],
  settings: { strategy: "hybrid", fusion: "rrf", rerank: { enabled: false, strategy: "llm" } },
  index: {
    namespace: "recursive__ollama-all-minilm",
    location: "data/index/recursive__ollama-all-minilm",
    embedder: "ollama:all-minilm",
    chunker: "recursive",
    chunks: 5,
    vectors: 5,
    parents: 0,
    gitCommit: "abc1234def",
    createdAt: "2026-10-19T10:00:00.000Z",
    loadMs: 7,
  },
  retrievers: [
    { name: "bm25", startMs: 0, durationMs: 3, results: bm25 },
    { name: "dense", startMs: 0, durationMs: 18, results: dense },
  ],
  retriever: "hybrid",
  // reranking is off in the default report, so the candidates are the result
  candidates: [hit(young, 1, 0.0325, "hybrid"), hit(purr, 2, 0.0323, "hybrid")],
  results: [hit(young, 1, 0.0325, "hybrid"), hit(purr, 2, 0.0323, "hybrid")],
  totalMs: 21,
  stages: [],
  ...overrides,
});

describe("describeSearch", () => {
  const text = describeSearch(report());

  it("shows the question, the index and the settings", () => {
    expect(text).toContain("Question: cats");
    expect(text).toContain("recursive__ollama-all-minilm: 5 chunks, 5 searchable");
    expect(text).toContain("at abc1234");
    expect(text).toContain("hybrid (fusion rrf), rerank off, k = 2, filter: none");
  });

  it("lists what each retriever found, with rank, score, page, section and text", () => {
    expect(text).toContain("bm25: 3 ms, 2 found");
    expect(text).toContain("dense: 18 ms, 2 found");
    expect(text).toMatch(/ 1 +1.3486 +p.1 Chapter 1 +"cats purr"/);
    expect(text).toMatch(/ 2 +0.8000 +p.2 Chapter 2 +"dogs bark and fetch"/);
  });

  it("then lists the final result under the name of the retriever that gave it", () => {
    expect(text).toContain("Final (hybrid): 2 chunks");
    expect(text.indexOf("Final (hybrid)")).toBeGreaterThan(text.indexOf("dense: 18 ms"));
  });

  it("ends with the time spent in each step", () => {
    expect(text).toContain("Time: index load 7 ms; bm25 3 ms, dense 18 ms; search total 21 ms");
  });

  it("calls a single retriever's list the result instead of repeating it as 'Final'", () => {
    const single = describeSearch(
      report({
        settings: { strategy: "dense", fusion: "rrf", rerank: { enabled: false, strategy: "llm" } },
        retrievers: [{ name: "dense", startMs: 0, durationMs: 18, results: dense }],
        retriever: "dense",
        results: dense,
      }),
    );
    expect(single).toContain("Result (dense): 2 chunks");
    expect(single).not.toContain("fusion");
  });

  it("says when nothing was found, mentions parents and a reranker, and cuts long text", () => {
    const long = { ...young, text: `${"word ".repeat(60)}end` };
    const out = describeSearch(
      report({
        index: { ...report().index, parents: 3 },
        settings: { strategy: "hybrid", fusion: "rrf", rerank: { enabled: true, strategy: "llm" } },
        retrievers: [{ name: "bm25", startMs: 0, durationMs: 1, results: [] }],
        results: [hit(long, 1, 0.5, "hybrid+parents")],
        retriever: "hybrid+parents",
      }),
    );
    expect(out).toContain("(nothing found)");
    expect(out).toContain("3 parents");
    expect(out).toContain("rerank llm");
    expect(out).toMatch(/word word .*…"/);
  });
});

describe("describeSearch: with reranking on", () => {
  const candidates = [
    hit(young, 1, 0.0325, "hybrid"),
    hit(purr, 2, 0.0323, "hybrid"),
    hit(furry, 3, 0.0317, "hybrid"),
  ];
  const text = describeSearch(
    report({
      settings: { strategy: "hybrid", fusion: "rrf", rerank: { enabled: true, strategy: "llm" } },
      candidates,
      results: [hit(furry, 1, 10, "hybrid"), hit(purr, 2, 8, "hybrid")],
    }),
  );

  it("shows the retriever's order and the reranked order, one after the other", () => {
    expect(text).toContain("Candidates (hybrid), before reranking: 3 chunks");
    expect(text).toContain("Reranked (hybrid, llm): 2 chunks");
    expect(text.indexOf("Candidates (hybrid)")).toBeLessThan(text.indexOf("Reranked (hybrid"));
    expect(text).not.toContain("Final (hybrid)");
  });

  it("lists the candidates in the retriever's order and the result with the reranker's scores", () => {
    const [before, after] = text.split("Reranked (hybrid, llm)") as [string, string];
    const order = (part: string) => [...part.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(order(before.split("before reranking")[1] ?? "")).toEqual([
      young.text,
      purr.text,
      furry.text.slice(0, 90),
    ]);
    expect(after).toMatch(/ 1 +10\.0000 .*"furry animals/);
    expect(after).toMatch(/ 2 + 8\.0000 .*"cats purr"/);
  });
});

describe("describeFilter", () => {
  it("describes each kind of clause", () => {
    expect(describeFilter([])).toBe("none");
    expect(
      describeFilter([
        { kind: "equals", field: "docId", value: "abc" },
        { kind: "in", field: "strategy", values: ["a", "b"] },
        { kind: "section", path: ["Chapter 3", "3.2 Embeddings"] },
        { kind: "pageRange", from: 10, to: 20 },
        { kind: "pageRange", from: 10 },
      ]),
    ).toBe(
      "docId = abc; strategy in (a, b); section Chapter 3 > 3.2 Embeddings; pages 10-20; pages 10-",
    );
  });
});

describe("searchToJson", () => {
  it("is the whole report as JSON that reads back the same", () => {
    const r = report();
    expect(JSON.parse(searchToJson(r))).toEqual(JSON.parse(JSON.stringify(r)));
    const parsed = JSON.parse(searchToJson(r)) as SearchReport;
    expect(parsed.retrievers.map((x) => x.name)).toEqual(["bm25", "dense"]);
    expect(parsed.results[0]?.chunk.text).toBe(young.text);
  });
});

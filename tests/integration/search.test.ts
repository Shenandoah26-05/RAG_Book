import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildSearcher, describeSearch } from "../../src/composition/index.js";
import type { SearchReport } from "../../src/composition/index.js";
import { noopLogger } from "../../src/shared/index.js";
import {
  DIMENSIONS,
  DOC_B,
  cars,
  dogs,
  furry,
  purr,
  writeFixtureIndex,
  young,
} from "../../src/testing/search-fixture.testing.js";

const ROOT = path.resolve(import.meta.dirname, "../..");
const run = promisify(execFile);

/** Stands in for Ollama: every question is embedded as the direction the fixture's chunks lean to. */
function fakeOllama(): typeof fetch & { calls: number } {
  const state = { calls: 0 };
  const fn = vi.fn(() => {
    state.calls++;
    const vector = Array.from({ length: DIMENSIONS }, (_, i) => (i === 0 ? 1 : 0));
    return Promise.resolve(
      new Response(JSON.stringify({ embeddings: [vector] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  });
  Object.defineProperty(fn, "calls", { get: () => state.calls });
  return fn as unknown as typeof fetch & { calls: number };
}

describe("pnpm search, over an index written to disk", () => {
  let dir: string;
  let indexDir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "rag-search-e2e-"));
    indexDir = path.join(dir, "index");
    await writeFixtureIndex(indexDir);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const searcher = (fetchFn: typeof fetch, extra: { variant?: string; argv?: string[] } = {}) =>
    buildSearcher({
      env: {},
      indexDir,
      cacheDir: path.join(dir, "cache"),
      logger: noopLogger,
      fetch: fetchFn,
      ...(extra.variant === undefined ? {} : { variant: extra.variant }),
      ...(extra.argv === undefined ? {} : { argv: extra.argv }),
    });
  const texts = (r: { chunk: { text: string } }[] | readonly { chunk: { text: string } }[]) =>
    r.map((x) => x.chunk.text);

  it("by default searches with the hybrid retriever and shows what dense and bm25 each found", async () => {
    const report = await (await searcher(fakeOllama(), { argv: [] })).search("cats", { k: 3 });

    expect(report.question).toBe("cats");
    expect(report.settings).toMatchObject({ strategy: "hybrid", fusion: "rrf" });
    expect(report.index).toMatchObject({
      namespace: "recursive__ollama-all-minilm",
      embedder: "ollama:all-minilm",
      chunks: 5,
      vectors: 5,
      parents: 0,
      gitCommit: "abc1234def",
    });

    // each retriever on its own: by words (bm25) and by meaning (dense)
    const byName = Object.fromEntries(report.retrievers.map((r) => [r.name, r]));
    expect(Object.keys(byName).sort()).toEqual(["bm25", "dense"]);
    expect(texts(byName["bm25"]?.results ?? [])).toEqual([purr.text, young.text, furry.text]);
    expect(texts(byName["dense"]?.results ?? []).slice(0, 3)).toEqual([
      young.text,
      dogs.text,
      furry.text,
    ]);
    for (const r of report.retrievers) {
      expect(r.results.map((x) => x.rank)).toEqual(r.results.map((_, i) => i + 1));
      expect(r.durationMs).toBeGreaterThanOrEqual(0);
    }

    // the fused list, at most k
    expect(report.retriever).toBe("hybrid");
    expect(report.results).toHaveLength(3);
    expect(report.results.every((r) => r.retriever === "hybrid")).toBe(true);
    expect(texts(report.results)).toEqual([young.text, purr.text, furry.text]);
    expect(report.totalMs).toBeGreaterThanOrEqual(0);
    expect(report.stages.map((s) => s.stage).sort()).toEqual(["bm25", "dense"]);
  });

  it("restricts every retriever with the filter", async () => {
    const report = await (
      await searcher(fakeOllama(), { argv: [] })
    ).search("cats", {
      k: 5,
      filter: [{ kind: "equals", field: "docId", value: DOC_B }],
    });
    for (const list of [...report.retrievers.map((r) => r.results), report.results]) {
      expect(list.length).toBeGreaterThan(0);
      expect(list.every((r) => r.chunk.metadata.docId === DOC_B)).toBe(true);
    }
    expect(texts(report.results)).toContain(cars.text);
  });

  it("takes k from the config unless asked", async () => {
    const run = await searcher(fakeOllama(), { argv: ["--retrieval.k", "2"] });
    expect((await run.search("cats")).results).toHaveLength(2);
    expect((await run.search("cats", { k: 4 })).results).toHaveLength(4);
  });

  describe("variants", () => {
    it("the bm25 variant searches by words only and never calls Ollama", async () => {
      const ollama = fakeOllama();
      const report = await (
        await searcher(ollama, { variant: "bm25", argv: [] })
      ).search("cats", {
        k: 5,
      });
      expect(report.settings.strategy).toBe("bm25");
      expect(report.retrievers.map((r) => r.name)).toEqual(["bm25"]);
      expect(report.retriever).toBe("bm25");
      expect(texts(report.results)).toEqual([purr.text, young.text, furry.text]);
      expect(ollama.calls).toBe(0);
    });

    it("the dense variant searches by meaning only", async () => {
      const ollama = fakeOllama();
      const report = await (
        await searcher(ollama, { variant: "dense", argv: [] })
      ).search("cats", {
        k: 2,
      });
      expect(report.retrievers.map((r) => r.name)).toEqual(["dense"]);
      expect(texts(report.results)).toEqual([young.text, dogs.text]);
      expect(ollama.calls).toBe(1);
    });

    it("the hybrid-weighted variant fuses with the weighted sum", async () => {
      const report = await (
        await searcher(fakeOllama(), { variant: "hybrid-weighted", argv: [] })
      ).search("cats", { k: 5 });
      expect(report.settings).toMatchObject({ strategy: "hybrid", fusion: "weighted" });
      // weighted scores are between 0 and 1, RRF scores are around 0.03
      expect(report.results[0]?.score).toBeGreaterThan(0.3);
    });

    it("rejects an unknown variant, listing the ones that exist", async () => {
      await expect(searcher(fakeOllama(), { variant: "magic", argv: [] })).rejects.toThrow(
        /No variant "magic".*bm25, dense, hybrid-weighted/,
      );
    });
  });

  describe("errors", () => {
    it("says how to build the index when there is none for the chunker and embedder", async () => {
      const run = await searcher(fakeOllama(), { argv: [] });
      await expect(run.search("cats", { chunker: "fixed-size" })).rejects.toThrow(
        /No index "fixed-size__ollama-all-minilm".*pnpm index/,
      );
    });

    it("rejects a bad k and a blank question", async () => {
      const run = await searcher(fakeOllama(), { argv: [] });
      await expect(run.search("cats", { k: 0 })).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
      });
      await expect(run.search("  ")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    });

    it("reports an Ollama that is not running for a dense search", async () => {
      const down: typeof fetch = () => Promise.reject(new TypeError("fetch failed"));
      const run = await searcher(down, { argv: [] });
      await expect(run.search("cats")).rejects.toThrow();
    }, 20_000);
  });

  it("describeSearch prints the report", async () => {
    const report = await (await searcher(fakeOllama(), { argv: [] })).search("cats", { k: 3 });
    const text = describeSearch(report);
    expect(text).toContain("bm25:");
    expect(text).toContain("dense:");
    expect(text).toContain("Final (hybrid): 3 chunks");
  });

  describe("as a command", () => {
    async function search(
      ...args: string[]
    ): Promise<{ code: number; stdout: string; stderr: string }> {
      try {
        const { stdout, stderr } = await run(
          process.execPath,
          ["node_modules/tsx/dist/cli.mjs", "src/cli/search.ts", ...args],
          { cwd: ROOT },
        );
        return { code: 0, stdout, stderr };
      } catch (error) {
        const failed = error as { code: number; stdout: string; stderr: string };
        return { code: failed.code, stdout: failed.stdout, stderr: failed.stderr };
      }
    }

    it("prints the retrieval trace as text", async () => {
      const result = await search("cats", "--variant", "bm25", "--index-dir", indexDir);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("Question: cats");
      expect(result.stdout).toContain("bm25:");
      expect(result.stdout).toContain('"cats purr"');
      expect(result.stdout).toMatch(/Time: index load \d+ ms; bm25 \d+ ms; search total \d+ ms/);
    }, 30_000);

    it("with --json prints only the report as JSON on standard output", async () => {
      const result = await search(
        "cats",
        "--variant",
        "bm25",
        "--k",
        "2",
        "--pages",
        "1",
        "--json",
        "--index-dir",
        indexDir,
      );
      expect(result.code).toBe(0);
      const report = JSON.parse(result.stdout) as SearchReport;
      expect(report.question).toBe("cats");
      expect(report.k).toBe(2);
      expect(report.filter).toEqual([{ kind: "pageRange", from: 1, to: 1 }]);
      expect(report.results.map((r) => r.chunk.text)).toEqual([purr.text, young.text]);
      expect(report.retrievers[0]?.name).toBe("bm25");
      // progress logs go to standard error, so the JSON stays clean
      expect(result.stderr).toContain("index loaded");
    }, 30_000);

    it("exits with 2 and shows the usage for a missing question or a bad option", async () => {
      const none = await search();
      expect(none.code).toBe(2);
      expect(none.stderr).toContain("No question given");
      expect(none.stderr).toContain("Usage: pnpm search");
      expect((await search("q", "--k", "0")).code).toBe(2);
    }, 30_000);

    it("exits with 1 and says to run pnpm index when there is no index", async () => {
      const result = await search(
        "cats",
        "--variant",
        "bm25",
        "--index-dir",
        path.join(dir, "none"),
      );
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("pnpm index");
    }, 30_000);
  });
});

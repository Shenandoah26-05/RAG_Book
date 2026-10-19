import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../config/index.js";
import type { Query, RetrieveOptions, RetrievedChunk, Retriever } from "../core/index.js";
import { RagError } from "../shared/index.js";
import { NoopReranker, RerankingRetriever } from "../strategies/index.js";
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
    expect(rerankerNames()).toEqual(["noop"]);
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
        buildReranker({ ...on, strategy: "llm" });
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(RagError);
    expect((error as RagError).code).toBe("CONFIG_INVALID");
    expect((error as RagError).message).toContain('Unknown reranker "llm" in rerank.strategy');
    expect((error as RagError).message).toContain("noop");
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

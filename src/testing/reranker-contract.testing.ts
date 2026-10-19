// The contract every Reranker must meet (see core/ports/reranker.ts). Used by each reranker's own
// test through `describeRerankerContract`. Not part of the build.
//
// Like the other contracts, the result checks are a plain function that returns the violations it
// finds, as data, so the contract itself can be tested with deliberately broken results.
import { describe, expect, it } from "vitest";
import { makeChunkId } from "../core/index.js";
import type { Query, RetrievedChunk, Reranker } from "../core/index.js";
import { makeDocId } from "../shared/index.js";

export type RerankerViolationCode =
  | "too-many" // more than k results
  | "bad-rank" // ranks are not 1, 2, 3, ... in order
  | "score-increases" // a later result scores higher than an earlier one
  | "duplicate" // the same chunk twice
  | "unknown-chunk" // a chunk that was not among the candidates
  | "changed-chunk" // a chunk's text or metadata differs from the candidate's
  | "changed-retriever"; // `retriever` differs from the candidate's

export interface RerankerViolation {
  readonly code: RerankerViolationCode;
  readonly message: string;
}

/** One line per violation, for a test failure message. */
export function formatRerankerViolations(violations: readonly RerankerViolation[]): string {
  return violations.map((v) => `${v.code}: ${v.message}`).join("\n");
}

/** Everything wrong with `results` as the answer to a `rerank` of `candidates` with `k`. */
export function checkReranked(
  results: readonly RetrievedChunk[],
  candidates: readonly RetrievedChunk[],
  k: number,
): readonly RerankerViolation[] {
  const found: RerankerViolation[] = [];
  const add = (code: RerankerViolationCode, message: string): void => {
    found.push({ code, message });
  };
  const byId = new Map(candidates.map((c) => [c.chunk.id, c]));

  if (results.length > k) {
    add("too-many", `${results.length.toString()} results for k = ${k.toString()}`);
  }
  const seen = new Set<string>();
  results.forEach((r, i) => {
    if (r.rank !== i + 1) add("bad-rank", `result ${i.toString()} has rank ${r.rank.toString()}`);
    const before = results[i - 1];
    if (before !== undefined && r.score > before.score) {
      add(
        "score-increases",
        `result ${i.toString()} scores ${r.score.toString()}, above ${before.score.toString()}`,
      );
    }
    if (seen.has(r.chunk.id)) add("duplicate", `chunk ${r.chunk.id} appears twice`);
    seen.add(r.chunk.id);
    const original = byId.get(r.chunk.id);
    if (original === undefined) {
      add("unknown-chunk", `chunk ${r.chunk.id} was not a candidate`);
      return;
    }
    if (JSON.stringify(original.chunk) !== JSON.stringify(r.chunk)) {
      add("changed-chunk", `chunk ${r.chunk.id} differs from the candidate`);
    }
    if (original.retriever !== r.retriever) {
      add(
        "changed-retriever",
        `chunk ${r.chunk.id} says "${r.retriever}", the candidate says "${original.retriever}"`,
      );
    }
  });
  return found;
}

const DOC = makeDocId("c".repeat(64));

/** `texts` as the result of a retriever called "dense": ranks 1.., scores falling from 0.9. */
export function makeCandidates(texts: readonly string[]): RetrievedChunk[] {
  return texts.map((text, index) => ({
    chunk: {
      id: makeChunkId({
        docId: DOC,
        strategy: "recursive",
        charStart: index * 100,
        charEnd: index * 100 + text.length,
        text,
      }),
      text,
      metadata: {
        docId: DOC,
        pageStart: index + 1,
        pageEnd: index + 1,
        sectionPath: [],
        charStart: index * 100,
        charEnd: index * 100 + text.length,
        strategy: "recursive",
      },
    },
    score: 0.9 - index * 0.1,
    rank: index + 1,
    retriever: "dense",
  }));
}

export interface RerankerFixture {
  readonly reranker: Reranker;
  readonly query: Query;
  /** At least 3 candidates, as a retriever would return them. */
  readonly candidates: readonly RetrievedChunk[];
}

/**
 * Registers the shared reranker tests for the reranker that `make` builds. Call it once per
 * implementation; `make` runs before each test so tests do not share state.
 */
export function describeRerankerContract(
  label: string,
  make: () => Promise<RerankerFixture>,
): void {
  describe(`${label} satisfies the Reranker contract`, () => {
    it("returns at most k of the candidates, best first, ranked from 1, each once", async () => {
      const { reranker, query, candidates } = await make();
      for (const k of [1, 2, 3, 50]) {
        const results = await reranker.rerank(query, candidates, { k });
        expect(results.length).toBeGreaterThan(0);
        const violations = checkReranked(results, candidates, k);
        expect(violations, formatRerankerViolations(violations)).toEqual([]);
      }
    });

    it("has a non-empty name", async () => {
      expect((await make()).reranker.name).not.toBe("");
    });

    it("does not change the candidates it was given", async () => {
      const { reranker, query, candidates } = await make();
      const before = JSON.stringify(candidates);
      await reranker.rerank(query, candidates, { k: 3 });
      expect(JSON.stringify(candidates)).toBe(before);
    });

    it("gives the same result for the same candidates", async () => {
      const { reranker, query, candidates } = await make();
      expect(await reranker.rerank(query, candidates, { k: 3 })).toEqual(
        await reranker.rerank(query, candidates, { k: 3 }),
      );
    });

    it("returns an empty list when there are no candidates", async () => {
      const { reranker, query } = await make();
      expect(await reranker.rerank(query, [], { k: 3 })).toEqual([]);
    });

    it.each([0, -1, 1.5, Number.NaN])("rejects k = %s as INVALID_ARGUMENT", async (k) => {
      const { reranker, query, candidates } = await make();
      await expect(reranker.rerank(query, candidates, { k })).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
      });
    });

    it.each(["", "   \n"])("rejects the blank question %j as INVALID_ARGUMENT", async (text) => {
      const { reranker, candidates } = await make();
      await expect(reranker.rerank({ text }, candidates, { k: 3 })).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
      });
    });
  });
}

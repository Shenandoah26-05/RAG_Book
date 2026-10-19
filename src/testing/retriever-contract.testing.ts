// The contract every Retriever must meet (see core/ports/retriever.ts). Used by each retriever's own
// test through `describeRetrieverContract`. Not part of the build.
//
// Like the other contracts, the result checks are a plain function that returns the violations it
// finds, as data, so the contract itself can be tested with deliberately broken results.
import { describe, expect, it } from "vitest";
import type { Chunk, MetadataFilter, Query, RetrievedChunk, Retriever } from "../core/index.js";

export type RetrieverViolationCode =
  | "too-many" // more than k results
  | "bad-rank" // ranks are not 1, 2, 3, ... in order
  | "score-increases" // a later result scores higher than an earlier one
  | "wrong-retriever" // `retriever` differs from the retriever's name
  | "duplicate" // the same chunk twice
  | "filter-violated"; // a chunk that does not satisfy the filter

export interface RetrieverViolation {
  readonly code: RetrieverViolationCode;
  readonly message: string;
}

export interface ResultCheck {
  readonly name: string;
  readonly k: number;
  /** Tells whether a chunk satisfies the filter that was used. Absent: no filter was used. */
  readonly allowed?: (chunk: Chunk) => boolean;
}

/** One line per violation, for a test failure message. */
export function formatRetrieverViolations(violations: readonly RetrieverViolation[]): string {
  return violations.map((v) => `${v.code}: ${v.message}`).join("\n");
}

/** Everything wrong with `results` as the answer to a `retrieve` with `check.k`. Empty if fine. */
export function checkRetrieved(
  results: readonly RetrievedChunk[],
  check: ResultCheck,
): readonly RetrieverViolation[] {
  const found: RetrieverViolation[] = [];
  const add = (code: RetrieverViolationCode, message: string): void => {
    found.push({ code, message });
  };

  if (results.length > check.k) {
    add("too-many", `${results.length.toString()} results for k = ${check.k.toString()}`);
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
    if (r.retriever !== check.name) {
      add(
        "wrong-retriever",
        `result ${i.toString()} says "${r.retriever}", expected "${check.name}"`,
      );
    }
    if (seen.has(r.chunk.id)) add("duplicate", `chunk ${r.chunk.id} appears twice`);
    seen.add(r.chunk.id);
    if (check.allowed !== undefined && !check.allowed(r.chunk)) {
      add("filter-violated", `chunk ${r.chunk.id} does not satisfy the filter`);
    }
  });
  return found;
}

export interface RetrieverFixture {
  readonly retriever: Retriever;
  /** A question the index can answer, with at least 3 chunks to return. */
  readonly query: Query;
  /** A filter that lets some, but not all, of those chunks through, and the test of it. */
  readonly filter: MetadataFilter;
  readonly allowed: (chunk: Chunk) => boolean;
}

/**
 * Registers the shared retriever tests for the retriever that `make` builds. Call it once per
 * implementation; `make` runs before each test so tests do not share state.
 */
export function describeRetrieverContract(
  label: string,
  make: () => Promise<RetrieverFixture>,
): void {
  describe(`${label} satisfies the Retriever contract`, () => {
    it("returns at most k chunks, best first, ranked from 1, each once", async () => {
      const { retriever, query } = await make();
      for (const k of [1, 2, 3, 50]) {
        const results = await retriever.retrieve(query, { k });
        expect(results.length).toBeGreaterThan(0);
        const violations = checkRetrieved(results, { name: retriever.name, k });
        expect(violations, formatRetrieverViolations(violations)).toEqual([]);
      }
    });

    it("has a non-empty name, used in every result", async () => {
      const { retriever, query } = await make();
      expect(retriever.name).not.toBe("");
      const results = await retriever.retrieve(query, { k: 3 });
      expect(results.every((r) => r.retriever === retriever.name)).toBe(true);
    });

    it("returns only chunks that satisfy the filter, fewer than k if need be", async () => {
      const { retriever, query, filter, allowed } = await make();
      const all = await retriever.retrieve(query, { k: 50 });
      const results = await retriever.retrieve(query, { k: 50, filter });
      expect(results.length).toBeGreaterThan(0);
      expect(results.length).toBeLessThan(all.length);
      const violations = checkRetrieved(results, { name: retriever.name, k: 50, allowed });
      expect(violations, formatRetrieverViolations(violations)).toEqual([]);
    });

    it("gives the same result for the same question", async () => {
      const { retriever, query } = await make();
      expect(await retriever.retrieve(query, { k: 5 })).toEqual(
        await retriever.retrieve(query, { k: 5 }),
      );
    });

    it.each([0, -1, 1.5, Number.NaN])("rejects k = %s as INVALID_ARGUMENT", async (k) => {
      const { retriever, query } = await make();
      await expect(retriever.retrieve(query, { k })).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
      });
    });

    it.each(["", "   \n"])("rejects the blank question %j as INVALID_ARGUMENT", async (text) => {
      const { retriever } = await make();
      await expect(retriever.retrieve({ text }, { k: 3 })).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
      });
    });
  });
}

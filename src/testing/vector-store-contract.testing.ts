// The contract every VectorStore must meet (see core/ports/vector-store.ts). Used by each store's
// own test through `describeVectorStoreContract`. Not part of the build.
//
// Like the chunker and embedder contracts, the checks are plain functions that return the
// violations they find, as data, so the contract itself can be tested with deliberately broken
// stores (vector-store-contract.test.ts). The expected answers come from a brute-force search
// written here, independent of any store and of strategies/ranking.
import { describe, expect, it } from "vitest";
import type {
  ChunkId,
  ChunkMetadata,
  DocId,
  MetadataFilter,
  ScoredId,
  VectorRecord,
  VectorStore,
} from "../core/index.js";
import { RagError } from "../shared/index.js";

export type VectorStoreViolationCode =
  | "wrong-count" // count() does not match what was stored
  | "wrong-hits" // the ids returned differ from the brute-force answer
  | "wrong-score" // a score differs from the cosine similarity
  | "bad-order" // scores are not in descending order
  | "too-many-hits" // more than k hits
  | "wrong-filter" // a filter let through, or held back, the wrong records
  | "not-replaced" // upserting an existing id did not replace its vector and metadata
  | "wrong-delete" // delete removed the wrong records, or failed on an unknown id
  | "not-deterministic" // the same search twice gave different hits
  | "dimensions-not-checked" // a vector of the wrong length was accepted
  | "not-atomic" // a batch with one invalid record was partly stored
  | "bad-argument-accepted"; // k, a page range or a section path that must be rejected was accepted

export interface VectorStoreViolation {
  readonly code: VectorStoreViolationCode;
  readonly message: string;
}

/** One line per violation, for a test failure message. */
export function formatVectorStoreViolations(violations: readonly VectorStoreViolation[]): string {
  return violations.map((v) => `${v.code}: ${v.message}`).join("\n");
}

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

export const FIXTURE_DIMENSIONS = 4;
const TOLERANCE = 1e-5;

const unit = (...values: number[]): Float32Array => {
  const length = Math.sqrt(values.reduce((s, x) => s + x * x, 0));
  return Float32Array.from(values.map((x) => x / length));
};

const meta = (
  docId: string,
  pageStart: number,
  pageEnd: number,
  strategy: string,
  sectionPath: readonly string[] = [],
): ChunkMetadata => ({
  docId: docId as DocId,
  pageStart,
  pageEnd,
  sectionPath,
  charStart: pageStart * 100,
  charEnd: pageEnd * 100 + 50,
  strategy,
});

const record = (id: string, vector: Float32Array, metadata: ChunkMetadata): VectorRecord => ({
  id: id as ChunkId,
  vector,
  metadata,
});

const CH1_INTRO = ["Chapter 1", "1.1 Intro"];
const CH2_EMBEDDINGS = ["Chapter 2", "2.1 Embeddings"];

/** Twelve records over two documents and two strategies. c10 and c11 share a vector (a tie). */
export function fixtureRecords(): VectorRecord[] {
  return [
    record("c00", unit(1, 0, 0, 0), meta("doc-a", 1, 1, "recursive", CH1_INTRO)),
    record("c01", unit(0.9, 0.1, 0, 0), meta("doc-a", 1, 2, "recursive", CH1_INTRO)),
    record(
      "c02",
      unit(0.7, 0.7, 0, 0),
      meta("doc-a", 3, 3, "fixed-size", ["Chapter 1", "1.2 Scope"]),
    ),
    record("c03", unit(0, 1, 0, 0), meta("doc-a", 4, 6, "fixed-size", CH2_EMBEDDINGS)),
    record("c04", unit(0, 0.8, 0.6, 0), meta("doc-a", 7, 7, "recursive", ["Chapter 2"])),
    record("c05", unit(0, 0, 1, 0), meta("doc-b", 1, 1, "recursive", ["Chapter 1"])),
    record("c06", unit(0, 0, 0.6, 0.8), meta("doc-b", 2, 3, "recursive", CH2_EMBEDDINGS)),
    record("c07", unit(0, 0, 0, 1), meta("doc-b", 5, 5, "fixed-size")),
    record("c08", unit(-1, 0, 0, 0), meta("doc-b", 6, 9, "fixed-size")),
    // the chapter title differs in case and spaces on purpose: section titles are compared folded
    record(
      "c09",
      unit(0.3, 0.3, 0.3, 0.3),
      meta("doc-b", 10, 10, "recursive", [" CHAPTER 2 ", "2.2 Search"]),
    ),
    record("c10", unit(0.5, -0.5, 0.5, -0.5), meta("doc-a", 8, 8, "recursive")),
    record("c11", unit(0.5, -0.5, 0.5, -0.5), meta("doc-b", 8, 8, "recursive")),
  ];
}

const Q0 = unit(1, 0, 0, 0);
const QUERIES: readonly Float32Array[] = [
  Q0,
  // c03 and c04 tie on this query up to rounding, on purpose: the contract must not depend on it
  unit(0.2, 0.9, 0.3, 0.1),
  unit(0.5, -0.5, 0.5, -0.5),
  unit(-0.3, 0.1, -0.8, 0.5),
];

const DOC_B: MetadataFilter = [{ kind: "equals", field: "docId", value: "doc-b" }];

const FILTERS: readonly { readonly name: string; readonly filter: MetadataFilter }[] = [
  { name: "docId equals", filter: DOC_B },
  {
    name: "strategy in",
    filter: [{ kind: "in", field: "strategy", values: ["fixed-size", "unknown"] }],
  },
  { name: "in with no values", filter: [{ kind: "in", field: "docId", values: [] }] },
  { name: "pageRange from and to", filter: [{ kind: "pageRange", from: 3, to: 5 }] },
  { name: "pageRange from only", filter: [{ kind: "pageRange", from: 8 }] },
  { name: "pageRange to only", filter: [{ kind: "pageRange", to: 1 }] },
  { name: "pageRange inside a multi-page chunk", filter: [{ kind: "pageRange", from: 5, to: 5 }] },
  {
    name: "several clauses",
    filter: [
      { kind: "equals", field: "docId", value: "doc-a" },
      { kind: "in", field: "strategy", values: ["recursive"] },
      { kind: "pageRange", from: 2, to: 8 },
    ],
  },
  { name: "section: a chapter", filter: [{ kind: "section", path: ["Chapter 2"] }] },
  {
    name: "section: a section inside a chapter",
    filter: [{ kind: "section", path: ["Chapter 2", "2.1 Embeddings"] }],
  },
  {
    name: "section: titles ignore case and spaces",
    filter: [{ kind: "section", path: ["  chapter 1 ", "1.1 INTRO"] }],
  },
  {
    name: "section: a path longer than the chunk's",
    filter: [{ kind: "section", path: ["Chapter 2", "2.1 Embeddings", "Deeper"] }],
  },
  {
    name: "section: a section title alone is not a chapter",
    filter: [{ kind: "section", path: ["1.1 Intro"] }],
  },
  {
    name: "section with docId and pageRange",
    filter: [
      { kind: "section", path: ["Chapter 2"] },
      { kind: "equals", field: "docId", value: "doc-b" },
      { kind: "pageRange", from: 3 },
    ],
  },
  { name: "nothing matches", filter: [{ kind: "equals", field: "docId", value: "doc-z" }] },
  { name: "empty filter", filter: [] },
];

// ---------------------------------------------------------------------------------------------
// The brute-force answer
// ---------------------------------------------------------------------------------------------

const dot = (a: Float32Array, b: Float32Array): number =>
  a.reduce((sum, x, i) => sum + x * (b[i] ?? 0), 0);

function matches(m: ChunkMetadata, filter: MetadataFilter): boolean {
  return filter.every((clause) => {
    switch (clause.kind) {
      case "equals":
        return m[clause.field] === clause.value;
      case "in":
        return clause.values.includes(m[clause.field]);
      case "section":
        return clause.path.every((title, i) => {
          const have = m.sectionPath[i];
          return have !== undefined && have.trim().toLowerCase() === title.trim().toLowerCase();
        });
      case "pageRange":
        return (
          (clause.from === undefined || m.pageEnd >= clause.from) &&
          (clause.to === undefined || m.pageStart <= clause.to)
        );
    }
  });
}

/** What a correct store returns: filter, score by cosine, best first, ties by id, first k. */
export function expectedHits(
  records: readonly VectorRecord[],
  query: Float32Array,
  k: number,
  filter: MetadataFilter = [],
): ScoredId[] {
  return records
    .filter((r) => matches(r.metadata, filter))
    .map((r) => ({ id: r.id, score: dot(r.vector, query) }))
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, k);
}

// ---------------------------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------------------------

const idsOf = (hits: readonly ScoredId[]): string => hits.map((h) => h.id).join(",");

/**
 * Whether `hits` are what a correct store returns, allowing for rounding. Two records whose true
 * scores differ by less than the tolerance may swap places, because different arithmetic (a
 * database, an approximate index) rounds differently. A hit that does not belong at all, or whose
 * score is clearly off, is still caught.
 */
function agrees(
  hits: readonly ScoredId[],
  records: readonly VectorRecord[],
  query: Float32Array,
  k: number,
  filter: MetadataFilter = [],
): boolean {
  const want = expectedHits(records, query, k, filter);
  if (hits.length !== want.length) return false;
  const allowed = new Map(
    expectedHits(records, query, records.length, filter).map((h) => [h.id, h.score]),
  );
  return hits.every((hit, i) => {
    const expected = want[i];
    if (expected === undefined) return false;
    if (hit.id === expected.id) return true;
    const score = allowed.get(hit.id);
    return score !== undefined && Math.abs(score - expected.score) <= TOLERANCE;
  });
}

/** Whether the call fails the way the port requires: a RagError coded INVALID_ARGUMENT. */
async function rejects(run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run();
    return false;
  } catch (error) {
    return error instanceof RagError && error.code === "INVALID_ARGUMENT";
  }
}

/**
 * Runs every check against a fresh store from `make` and returns the violations (empty when the
 * store is fine). `make` receives the dimensions the store must have.
 */
export async function checkVectorStore(
  make: (dimensions: number) => VectorStore,
): Promise<readonly VectorStoreViolation[]> {
  const violations: VectorStoreViolation[] = [];
  const fail = (code: VectorStoreViolationCode, message: string): void => {
    violations.push({ code, message });
  };
  const store = make(FIXTURE_DIMENSIONS);
  const records = fixtureRecords();

  // an empty store
  if ((await store.count()) !== 0) fail("wrong-count", "a new store is not empty");
  if ((await store.search(Q0, 3)).length !== 0) fail("wrong-hits", "an empty store returned hits");

  // storing, in two batches, and an empty batch
  await store.upsert([]);
  await store.upsert(records.slice(0, 5));
  await store.upsert(records.slice(5));
  const stored = await store.count();
  if (stored !== records.length) {
    fail("wrong-count", `${records.length.toString()} stored, count() is ${stored.toString()}`);
  }

  // searching without a filter
  for (const [q, query] of QUERIES.entries()) {
    for (const k of [1, 3, 50]) {
      const hits = await store.search(query, k);
      const want = expectedHits(records, query, k);
      const label = `query ${q.toString()}, k ${k.toString()}`;
      if (hits.length > k) fail("too-many-hits", `${label}: ${hits.length.toString()} hits`);
      if (hits.some((h, i) => i > 0 && h.score > (hits[i - 1]?.score ?? Infinity) + TOLERANCE)) {
        fail("bad-order", `${label}: scores are not descending`);
      }
      if (!agrees(hits, records, query, k)) {
        fail("wrong-hits", `${label}: got [${idsOf(hits)}], expected [${idsOf(want)}]`);
      } else if (hits.some((h, i) => Math.abs(h.score - (want[i]?.score ?? NaN)) > TOLERANCE)) {
        fail("wrong-score", `${label}: scores differ from the cosine similarity`);
      }
    }
  }

  // filters
  for (const { name, filter } of FILTERS) {
    for (const [q, query] of QUERIES.entries()) {
      const hits = await store.search(query, 50, filter);
      const want = expectedHits(records, query, 50, filter);
      if (!agrees(hits, records, query, 50, filter)) {
        const label = `${name}, query ${q.toString()}`;
        fail("wrong-filter", `${label}: got [${idsOf(hits)}], expected [${idsOf(want)}]`);
      }
    }
  }
  // k counts hits that pass the filter: filtering after taking k would return too few
  if (!agrees(await store.search(Q0, 2, DOC_B), records, Q0, 2, DOC_B)) {
    fail("wrong-filter", "k is applied before the filter instead of after it");
  }

  // records with identical vectors tie exactly, and a tie is broken by id, ascending
  const tied = await store.search(unit(0.5, -0.5, 0.5, -0.5), 2);
  if (idsOf(tied) !== "c10,c11") {
    fail("wrong-hits", `identical vectors must be ordered by id, got [${idsOf(tied)}]`);
  }

  // the same search twice
  const q1 = QUERIES[1] ?? Q0;
  if (JSON.stringify(await store.search(q1, 5)) !== JSON.stringify(await store.search(q1, 5))) {
    fail("not-deterministic", "the same search gave different hits");
  }

  // upsert replaces the vector and the metadata of an existing id
  const moved = record("c00", unit(0, 0, 0, 1), meta("doc-c", 20, 20, "semantic"));
  await store.upsert([moved]);
  const afterReplace = records.map((r) => (r.id === moved.id ? moved : r));
  if ((await store.count()) !== records.length) {
    fail("not-replaced", "upserting an existing id changed the count");
  }
  const toward = unit(0, 0, 0, 1);
  if (!agrees(await store.search(toward, 3), afterReplace, toward, 3)) {
    fail("not-replaced", "the new vector of a replaced record is not used");
  }
  const byNewDoc: MetadataFilter = [{ kind: "equals", field: "docId", value: "doc-c" }];
  const byOldPage: MetadataFilter = [
    { kind: "equals", field: "docId", value: "doc-a" },
    { kind: "pageRange", to: 1 },
  ];
  const newMeta = await store.search(Q0, 50, byNewDoc);
  const oldMeta = await store.search(Q0, 50, byOldPage);
  if (idsOf(newMeta) !== "c00" || oldMeta.some((h) => h.id === "c00")) {
    fail("not-replaced", "the new metadata of a replaced record is not used");
  }

  // delete
  try {
    await store.delete(["c01" as ChunkId, "no-such-id" as ChunkId]);
    await store.delete([]);
  } catch {
    fail("wrong-delete", "deleting an unknown id or an empty list failed");
  }
  const remaining = afterReplace.filter((r) => r.id !== "c01");
  const left = await store.count();
  if (left !== remaining.length) {
    fail("wrong-delete", `count() is ${left.toString()} after deleting one record`);
  }
  if (!agrees(await store.search(Q0, 50), remaining, Q0, 50)) {
    fail("wrong-delete", "a deleted record is still returned, or another one went with it");
  }

  // invalid input is rejected, and a rejected batch changes nothing
  const before = await store.count();
  const fresh = record("fresh", unit(1, 1, 1, 1), meta("doc-a", 1, 1, "recursive"));
  const badVector = record("bad", Float32Array.from([1, 0, 0]), meta("doc-a", 1, 1, "recursive"));
  if (!(await rejects(() => store.upsert([badVector])))) {
    fail("dimensions-not-checked", "a record with the wrong number of dimensions was accepted");
  }
  if (!(await rejects(() => store.search(Float32Array.from([1, 0, 0, 0, 0]), 3)))) {
    fail("dimensions-not-checked", "a query with the wrong number of dimensions was accepted");
  }
  await store.upsert([fresh, badVector]).catch(() => undefined);
  if ((await store.count()) !== before) {
    fail("not-atomic", "a batch with an invalid record was partly stored");
  }
  for (const k of [0, -1, 1.5, Number.NaN]) {
    if (!(await rejects(() => store.search(Q0, k)))) {
      fail("bad-argument-accepted", `k = ${String(k)} was accepted`);
    }
  }
  for (const range of [{ from: 5, to: 3 }, { from: 0 }, { to: 2.5 }]) {
    if (!(await rejects(() => store.search(Q0, 3, [{ kind: "pageRange", ...range }])))) {
      fail("bad-argument-accepted", `page range ${JSON.stringify(range)} was accepted`);
    }
  }

  for (const path of [[], [" "], ["Chapter 1", ""]]) {
    if (!(await rejects(() => store.search(Q0, 3, [{ kind: "section", path }])))) {
      fail("bad-argument-accepted", `section path ${JSON.stringify(path)} was accepted`);
    }
  }

  return violations;
}

/** Registers the contract tests for a store. Call it from the store's own test file. */
export function describeVectorStoreContract(
  name: string,
  make: (dimensions: number) => VectorStore,
): void {
  describe(`${name} meets the VectorStore contract`, () => {
    it("reports the dimensions it was made with", () => {
      expect(make(FIXTURE_DIMENSIONS).dimensions).toBe(FIXTURE_DIMENSIONS);
      expect(make(7).dimensions).toBe(7);
    });

    it("passes every check", async () => {
      const violations = await checkVectorStore(make);
      expect(violations, formatVectorStoreViolations(violations)).toEqual([]);
    });
  });
}

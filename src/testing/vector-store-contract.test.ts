import { describe, expect, it } from "vitest";
import type {
  ChunkId,
  MetadataFilter,
  ScoredId,
  VectorRecord,
  VectorStore,
} from "../core/index.js";
import { RagError } from "../shared/index.js";
import {
  checkVectorStore,
  describeVectorStoreContract,
  expectedHits,
  formatVectorStoreViolations,
  type VectorStoreViolationCode,
} from "./vector-store-contract.testing.js";

interface Faults {
  /** Accept vectors of any length. */
  readonly skipDimensionCheck?: boolean;
  /** Store the valid records of a batch before reporting the invalid one. */
  readonly partialBatches?: boolean;
  /** Keep the old record when an id is upserted again. */
  readonly keepOldOnUpsert?: boolean;
  /** Accept k below 1 and page ranges that must be rejected. */
  readonly acceptAnyArgument?: boolean;
}

const invalid = (message: string): RagError => new RagError("INVALID_ARGUMENT", message);

/**
 * A correct reference store: a map and a brute-force search. It exists only to show that the
 * contract accepts a good store (the real one is RAG-041), and to be broken on purpose below.
 */
class ReferenceStore implements VectorStore {
  readonly #records = new Map<ChunkId, VectorRecord>();

  constructor(
    readonly dimensions: number,
    readonly faults: Faults = {},
  ) {}

  upsert(records: readonly VectorRecord[]): Promise<void> {
    const wrong = records.find((r) => r.vector.length !== this.dimensions);
    if (this.faults.partialBatches === true) {
      for (const r of records) {
        if (r.vector.length === this.dimensions) this.#records.set(r.id, r);
      }
    }
    if (wrong !== undefined && this.faults.skipDimensionCheck !== true) {
      return Promise.reject(
        invalid(`record ${wrong.id} has ${wrong.vector.length.toString()} dimensions`),
      );
    }
    for (const r of records) {
      if (this.faults.keepOldOnUpsert === true && this.#records.has(r.id)) continue;
      this.#records.set(r.id, r);
    }
    return Promise.resolve();
  }

  search(query: Float32Array, k: number, filter?: MetadataFilter): Promise<readonly ScoredId[]> {
    if (query.length !== this.dimensions && this.faults.skipDimensionCheck !== true) {
      return Promise.reject(invalid("wrong query length"));
    }
    if (this.faults.acceptAnyArgument !== true) {
      if (!Number.isInteger(k) || k < 1) return Promise.reject(invalid(`bad k ${String(k)}`));
      for (const clause of filter ?? []) {
        if (clause.kind === "section") {
          if (clause.path.length === 0 || clause.path.some((title) => title.trim() === "")) {
            return Promise.reject(invalid("bad section path"));
          }
          continue;
        }
        if (clause.kind !== "pageRange") continue;
        const { from, to } = clause;
        const whole = (n: number | undefined): boolean =>
          n === undefined || (Number.isInteger(n) && n >= 1);
        if (!whole(from) || !whole(to) || (from !== undefined && to !== undefined && from > to)) {
          return Promise.reject(invalid("bad page range"));
        }
      }
    }
    return Promise.resolve(expectedHits([...this.#records.values()], query, k, filter));
  }

  delete(ids: readonly ChunkId[]): Promise<void> {
    for (const id of ids) this.#records.delete(id);
    return Promise.resolve();
  }

  count(): Promise<number> {
    return Promise.resolve(this.#records.size);
  }
}

type Make = (dimensions: number) => VectorStore;

/** The reference store with some of its methods replaced. */
function derive(good: ReferenceStore, override: Partial<VectorStore>): VectorStore {
  return {
    dimensions: good.dimensions,
    upsert: (r) => good.upsert(r),
    search: (q, k, f) => good.search(q, k, f),
    delete: (ids) => good.delete(ids),
    count: () => good.count(),
    ...override,
  };
}

/** The reference store, with `change` applied to what every search returns. */
function brokenSearch(
  change: (hits: readonly ScoredId[], k: number, calls: number) => readonly ScoredId[],
): Make {
  return (dims) => {
    const good = new ReferenceStore(dims);
    let calls = 0;
    return derive(good, {
      search: async (q, k, f) => change(await good.search(q, k, f), k, (calls += 1)),
    });
  };
}

describeVectorStoreContract("reference store", (dims) => new ReferenceStore(dims));

describe("the vector store contract catches broken stores", () => {
  const cases: [VectorStoreViolationCode, string, Make][] = [
    [
      "wrong-count",
      "reports one record too many",
      (dims) => {
        const good = new ReferenceStore(dims);
        return derive(good, { count: async () => (await good.count()) + 1 });
      },
    ],
    ["wrong-hits", "drops the best hit", brokenSearch((hits) => hits.slice(1))],
    [
      "wrong-score",
      "doubles every score",
      brokenSearch((hits) => hits.map((h) => ({ ...h, score: h.score * 2 }))),
    ],
    ["bad-order", "returns the worst hit first", brokenSearch((hits) => [...hits].reverse())],
    [
      "too-many-hits",
      "returns an extra hit",
      (dims) => {
        const good = new ReferenceStore(dims);
        return derive(good, { search: (q, k, f) => good.search(q, k + 1, f) });
      },
    ],
    [
      "wrong-filter",
      "ignores the filter",
      (dims) => {
        const good = new ReferenceStore(dims);
        return derive(good, { search: (q, k) => good.search(q, k) });
      },
    ],
    [
      "wrong-filter",
      "takes k hits and filters them afterwards",
      (dims) => {
        const good = new ReferenceStore(dims);
        return derive(good, {
          search: async (q, k, f) => {
            const all = await good.search(q, k);
            const wanted = new Set((await good.search(q, 1000, f)).map((h) => h.id));
            return all.filter((h) => wanted.has(h.id));
          },
        });
      },
    ],
    [
      "not-replaced",
      "keeps the old record on upsert",
      (dims) => new ReferenceStore(dims, { keepOldOnUpsert: true }),
    ],
    [
      "wrong-delete",
      "fails on an unknown id",
      (dims) => {
        const good = new ReferenceStore(dims);
        return derive(good, {
          delete: async (ids) => {
            if (ids.includes("no-such-id" as ChunkId)) throw new Error("unknown id");
            await good.delete(ids);
          },
        });
      },
    ],
    [
      "not-deterministic",
      "gives a different answer every other time",
      brokenSearch((hits, _k, calls) => (calls % 2 === 0 ? [...hits].reverse() : hits)),
    ],
    [
      "dimensions-not-checked",
      "accepts vectors of any length",
      (dims) => new ReferenceStore(dims, { skipDimensionCheck: true }),
    ],
    [
      "not-atomic",
      "stores the valid part of a bad batch",
      (dims) => new ReferenceStore(dims, { partialBatches: true }),
    ],
    [
      "bad-argument-accepted",
      "accepts k = 0 and a reversed page range",
      (dims) => new ReferenceStore(dims, { acceptAnyArgument: true }),
    ],
  ];

  it.each(cases)("%s: a store that %s", async (code, _what, make) => {
    const found = (await checkVectorStore(make)).map((v) => v.code);
    expect(found).toContain(code);
  });

  it("reports every problem, not just the first", async () => {
    const found = (
      await checkVectorStore(
        (dims) => new ReferenceStore(dims, { skipDimensionCheck: true, acceptAnyArgument: true }),
      )
    ).map((v) => v.code);
    expect(found).toEqual(
      expect.arrayContaining(["dimensions-not-checked", "bad-argument-accepted"]),
    );
  });
});

describe("the vector store contract and ties", () => {
  /** Swaps the two named records where they sit next to each other with (nearly) equal scores. */
  const swapped = (a: string, b: string): Make =>
    brokenSearch((hits) => {
      const out = [...hits];
      for (let i = 0; i + 1 < out.length; i += 1) {
        const first = out[i];
        const second = out[i + 1];
        const close = first && second && Math.abs(first.score - second.score) < 1e-6;
        if (close && [a, b].includes(first.id) && [a, b].includes(second.id)) {
          out[i] = second;
          out[i + 1] = first;
          i += 1;
        }
      }
      return out;
    });

  it("lets two records swap places when their scores differ only by rounding", async () => {
    // c03 and c04 tie on one fixture query up to rounding
    const violations = await checkVectorStore(swapped("c03", "c04"));
    expect(violations.map((v) => v.code)).toEqual([]);
  });

  it("still requires identical vectors to be ordered by id", async () => {
    // c10 and c11 have the very same vector, so their order is decided by id alone
    const found = (await checkVectorStore(swapped("c10", "c11"))).map((v) => v.code);
    expect(found).toContain("wrong-hits");
  });
});

describe("formatVectorStoreViolations", () => {
  it("writes one readable line per violation", () => {
    expect(
      formatVectorStoreViolations([
        { code: "wrong-count", message: "one too many" },
        { code: "bad-order", message: "scores go up" },
      ]),
    ).toBe("wrong-count: one too many\nbad-order: scores go up");
  });
});

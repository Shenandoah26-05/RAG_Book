import { performance } from "node:perf_hooks";
import type { ChunkId, ChunkMetadata, DocId, VectorRecord } from "../src/core/index.js";
import { FlatVectorStore, HnswVectorStore } from "../src/strategies/in-memory-index/index.js";
import { normalise } from "../src/strategies/ranking/index.js";

// RAG-044: what does approximate search cost and save? Compares HnswVectorStore with the exact
// FlatVectorStore on recall@10, query latency and number of vector comparisons.
// Run: pnpm bench:hnsw   (optional: SIZES=2000,10000 DIMENSIONS=384 QUERIES=200 pnpm bench:hnsw)
//
// The vectors are synthetic: a number of cluster centres, and each vector is a centre plus noise,
// so the data has the neighbourhood structure real text embeddings have. Uniform random vectors
// would be the worst case for any graph index, and are not what a book looks like. A real book is
// roughly 1,000 to 5,000 chunks, which is the first two sizes below.

const SIZES = (process.env.SIZES ?? "2000,10000,50000").split(",").map(Number);
const DIMENSIONS = Number(process.env.DIMENSIONS ?? 384);
const QUERIES = Number(process.env.QUERIES ?? 200);
const EF_SEARCH = [16, 32, 64, 128, 256];
const K = 10;

function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const next = random(2024);
const gaussian = (): number =>
  Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(2 * Math.PI * next());

const meta: ChunkMetadata = {
  docId: "book" as DocId,
  pageStart: 1,
  pageEnd: 1,
  sectionPath: [],
  charStart: 0,
  charEnd: 1,
  strategy: "recursive",
};

function makeData(size: number): { records: VectorRecord[]; queries: Float32Array[] } {
  const clusters = Math.max(10, Math.round(Math.sqrt(size)));
  const centres = Array.from({ length: clusters }, () =>
    Float32Array.from({ length: DIMENSIONS }, gaussian),
  );
  const around = (): Float32Array => {
    const centre = centres[Math.floor(next() * clusters)] ?? new Float32Array(DIMENSIONS);
    return normalise(centre.map((x) => x + 0.8 * gaussian()));
  };
  return {
    records: Array.from({ length: size }, (_, i) => ({
      id: `c${i.toString().padStart(6, "0")}` as ChunkId,
      vector: around(),
      metadata: meta,
    })),
    queries: Array.from({ length: QUERIES }, around),
  };
}

const median = (xs: number[]): number =>
  [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;

async function timeQueries(
  store: FlatVectorStore | HnswVectorStore,
  queries: Float32Array[],
): Promise<number> {
  const times: number[] = [];
  for (const query of queries) {
    const start = performance.now();
    await store.search(query, K);
    times.push(performance.now() - start);
  }
  return median(times);
}

console.log(
  `k=${K.toString()}  dimensions=${DIMENSIONS.toString()}  queries=${QUERIES.toString()}\n`,
);
console.log("chunks  | build ms | flat ms/q | ef  | hnsw ms/q | speed-up | recall@10 | compared");
console.log("--------|----------|-----------|-----|-----------|----------|-----------|---------");

for (const size of SIZES) {
  const { records, queries } = makeData(size);
  const flat = new FlatVectorStore(DIMENSIONS);
  await flat.upsert(records);
  const hnsw = new HnswVectorStore(DIMENSIONS);
  const buildStart = performance.now();
  await hnsw.upsert(records);
  const buildMs = performance.now() - buildStart;

  const truth = await Promise.all(queries.map((q) => flat.search(q, K)));
  const flatMs = await timeQueries(flat, queries);

  for (const ef of EF_SEARCH) {
    hnsw.efSearch = ef;
    let hits = 0;
    const before = hnsw.comparisons;
    for (const [i, query] of queries.entries()) {
      const exact = new Set(truth[i]?.map((h) => h.id));
      hits += (await hnsw.search(query, K)).filter((h) => exact.has(h.id)).length;
    }
    const compared = (hnsw.comparisons - before) / queries.length;
    const hnswMs = await timeQueries(hnsw, queries);
    console.log(
      [
        size.toString().padStart(7),
        (ef === EF_SEARCH[0] ? buildMs.toFixed(0) : "").padStart(8),
        (ef === EF_SEARCH[0] ? flatMs.toFixed(3) : "").padStart(9),
        ef.toString().padStart(3),
        hnswMs.toFixed(3).padStart(9),
        `${(flatMs / hnswMs).toFixed(1)}x`.padStart(8),
        (hits / (queries.length * K)).toFixed(3).padStart(9),
        compared.toFixed(0).padStart(8),
      ].join(" | "),
    );
  }
}

import { performance } from "node:perf_hooks";
import { cosine, dot, normalise } from "../src/strategies/ranking/index.js";

// Compares cosine and dot product on normalised vectors: same ranking, different cost.
// Run: pnpm bench:similarity   (optional: VECTORS=50000 DIMENSIONS=768 pnpm bench:similarity)

const VECTORS = Number(process.env.VECTORS ?? 20_000);
const DIMENSIONS = Number(process.env.DIMENSIONS ?? 384);
const ROUNDS = 5;
const TOP = 10;

// A small seeded generator (mulberry32), so every run uses the same vectors.
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const next = random(42);
const randomVector = (): Float32Array =>
  normalise(Float32Array.from({ length: DIMENSIONS }, () => next() - 0.5));

const corpus = Array.from({ length: VECTORS }, randomVector);
const query = randomVector();

const topIds = (score: (v: Float32Array) => number): number[] =>
  corpus
    .map((vector, id) => ({ id, score: score(vector) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP)
    .map((hit) => hit.id);

function timeMs(score: (v: Float32Array) => number): number {
  let best = Infinity;
  let sink = 0;
  for (let round = 0; round < ROUNDS; round += 1) {
    const start = performance.now();
    for (const vector of corpus) sink += score(vector);
    best = Math.min(best, performance.now() - start);
  }
  // uses the sum, so the loop cannot be optimised away
  if (Number.isNaN(sink)) throw new Error("scores were NaN");
  return best;
}

const byCosine = (v: Float32Array): number => cosine(query, v);
const byDot = (v: Float32Array): number => dot(query, v);

const sameRanking = topIds(byCosine).join() === topIds(byDot).join();
const cosineMs = timeMs(byCosine);
const dotMs = timeMs(byDot);

console.log(
  `${String(VECTORS)} vectors x ${String(DIMENSIONS)} dimensions, best of ${String(ROUNDS)}`,
);
console.log(`cosine: ${cosineMs.toFixed(1)} ms`);
console.log(`dot:    ${dotMs.toFixed(1)} ms  (${(cosineMs / dotMs).toFixed(1)}x faster)`);
console.log(`top ${String(TOP)} identical: ${sameRanking ? "yes" : "NO"}`);
if (!sameRanking) process.exitCode = 1;

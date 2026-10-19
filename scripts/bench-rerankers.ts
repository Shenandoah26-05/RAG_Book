import { performance } from "node:perf_hooks";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { resolveRerank } from "../src/composition/index.js";
import { makeChunkId } from "../src/core/index.js";
import type { RetrievedChunk } from "../src/core/index.js";
import { makeDocId } from "../src/shared/index.js";

const DOC = makeDocId("c".repeat(64));

/** The texts as the result of a retriever called "dense", best first. */
const makeCandidates = (texts: readonly string[]): RetrievedChunk[] =>
  texts.map((text, i) => {
    const metadata = {
      docId: DOC,
      pageStart: i + 1,
      pageEnd: i + 1,
      sectionPath: [],
      charStart: i * 1000,
      charEnd: i * 1000 + text.length,
      strategy: "bench",
    };
    const { docId, charStart, charEnd, strategy } = metadata;
    const id = makeChunkId({ docId, strategy, charStart, charEnd, text });
    return {
      chunk: { id, text, metadata },
      score: 1 - i / texts.length,
      rank: i + 1,
      retriever: "dense",
    };
  });

// Times a reranker on a small fixed set of candidates and shows the order it chooses.
// Run: pnpm bench:rerank [strategy]   (default: cross-encoder; ROUNDS=5 CANDIDATES=20 to change)
// The model loads on the first call and is timed apart from the later calls.

const strategy = process.argv[2] ?? "cross-encoder";
const ROUNDS = Number(process.env.ROUNDS ?? 5);
const CANDIDATES = Number(process.env.CANDIDATES ?? 20);

const QUESTION = "Which planet is known as the Red Planet?";
const RELEVANT = "Mars, known for its reddish appearance, is often called the Red Planet.";
const FILLER = [
  "Venus is often called Earth's twin because of its similar size.",
  "Quarterly tax returns are due in April.",
  "The mitochondria is the powerhouse of the cell.",
  "Jupiter is the largest planet in the solar system.",
  "A binary search tree keeps its keys in sorted order.",
  "Saturn is known for its prominent ring system.",
  "The French Revolution began in 1789.",
  "Photosynthesis turns light into chemical energy.",
];

// the right passage is placed in the middle, so a reranker has to move it up
const texts = Array.from({ length: CANDIDATES }, (_, i) =>
  i === Math.floor(CANDIDATES / 2)
    ? RELEVANT
    : `${FILLER[i % FILLER.length] ?? ""} (${i.toString()})`,
);
const candidates = makeCandidates(texts);

const { reranker } = resolveRerank({ ...DEFAULT_CONFIG.rerank, enabled: true, strategy });
const k = 3;

let t0 = performance.now();
let results = await reranker.rerank({ text: QUESTION }, candidates, { k });
const firstMs = performance.now() - t0;

const times: number[] = [];
for (let round = 0; round < ROUNDS; round += 1) {
  t0 = performance.now();
  results = await reranker.rerank({ text: QUESTION }, candidates, { k });
  times.push(performance.now() - t0);
}
times.sort((a, b) => a - b);

console.log(
  `reranker ${reranker.name}: ${CANDIDATES.toString()} candidates -> top ${k.toString()}`,
);
console.log(`first call (loads the model): ${firstMs.toFixed(0)} ms`);
console.log(
  `later calls: median ${(times[Math.floor(times.length / 2)] ?? 0).toFixed(0)} ms, best ${(times[0] ?? 0).toFixed(0)} ms over ${ROUNDS.toString()}`,
);
for (const r of results) {
  const was = candidates.findIndex((c) => c.chunk.id === r.chunk.id) + 1;
  console.log(
    `  #${r.rank.toString()} (was #${was.toString()}) score ${r.score.toFixed(2)}  ${r.chunk.text.slice(0, 60)}`,
  );
}

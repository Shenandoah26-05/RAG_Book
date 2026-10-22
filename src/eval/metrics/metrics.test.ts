import { describe, expect, it } from "vitest";
import type { Chunk, ChunkId, DocId, RetrievedChunk } from "../../core/index.js";
import { makeDocument } from "../../testing/make-document.testing.js";
import type { Question } from "../dataset/index.js";
import { meanMetrics } from "./aggregate.js";
import { goldPassages, judgeRetrieval, spansOverlap } from "./judge.js";
import type { GoldPassage } from "./judge.js";
import {
  hitAtK,
  ndcgAtK,
  precisionAtK,
  recallAtK,
  reciprocalRank,
  retrievalMetrics,
  scoreRetrieval,
} from "./metrics.js";

const DOC = "doc" as DocId;
/** The values below are worked out by hand in the comments. */
const log2 = Math.log2;

/** The chunk covering `[start, end)` of `doc`, wrapped as a retrieval result. */
function result(start: number, end: number, doc: DocId = DOC): RetrievedChunk {
  const chunk: Chunk = {
    id: `c${start.toString()}-${end.toString()}` as ChunkId,
    text: "x",
    metadata: {
      docId: doc,
      pageStart: 1,
      pageEnd: 1,
      sectionPath: [],
      charStart: start,
      charEnd: end,
      strategy: "recursive",
    },
  };
  return { chunk, score: 1, rank: 1, retriever: "test" };
}

const A: GoldPassage = { docId: DOC, span: { start: 100, end: 150 } };
const B: GoldPassage = { docId: DOC, span: { start: 400, end: 450 } };

describe("spansOverlap", () => {
  it("is true when the ranges share a character", () => {
    expect(spansOverlap({ start: 0, end: 10 }, { start: 9, end: 20 })).toBe(true);
    expect(spansOverlap({ start: 5, end: 8 }, { start: 0, end: 100 })).toBe(true);
    expect(spansOverlap({ start: 0, end: 10 }, { start: 0, end: 10 })).toBe(true);
  });

  it("is false when the ranges only touch, because the end is exclusive", () => {
    expect(spansOverlap({ start: 0, end: 10 }, { start: 10, end: 20 })).toBe(false);
    expect(spansOverlap({ start: 10, end: 20 }, { start: 0, end: 10 })).toBe(false);
  });

  it("is false for an empty range, even inside another", () => {
    expect(spansOverlap({ start: 5, end: 5 }, { start: 0, end: 10 })).toBe(false);
  });
});

describe("judgeRetrieval", () => {
  it("marks the chunks that overlap a gold passage, and the first to find each", () => {
    const judgement = judgeRetrieval(
      [result(90, 160), result(95, 140), result(200, 260), result(420, 430)],
      [A, B],
    );
    expect(judgement).toEqual({
      goldCount: 2,
      relevant: [true, true, false, true],
      newlyCovered: [true, false, false, true],
    });
  });

  it("ignores a chunk of another document, even over the same characters", () => {
    const judgement = judgeRetrieval([result(100, 150, "other" as DocId)], [A]);
    expect(judgement.relevant).toEqual([false]);
  });

  it("refuses a question with no gold passages", () => {
    expect(() => judgeRetrieval([result(0, 10)], [])).toThrowError(
      expect.objectContaining({ code: "INVALID_ARGUMENT" }) as Error,
    );
  });
});

describe("the five metrics, worked out by hand", () => {
  // rank 1 [90,160) finds A; 2 [200,260) nothing; 3 [420,430) finds B; 4 [0,50) nothing;
  // 5 [150,200) only touches A's end, so nothing
  const found = judgeRetrieval(
    [result(90, 160), result(200, 260), result(420, 430), result(0, 50), result(150, 200)],
    [A, B],
  );
  const ideal2 = 1 + 1 / log2(3); // best possible for 2 passages: 1 + 0.6309 = 1.6309

  it("at k = 5", () => {
    expect(hitAtK(found, 5)).toBe(1);
    expect(precisionAtK(found, 5)).toBeCloseTo(2 / 5, 12);
    expect(recallAtK(found, 5)).toBe(1);
    expect(reciprocalRank(found, 5)).toBe(1);
    // DCG = 1/log2(2) + 1/log2(4) = 1 + 0.5 = 1.5
    expect(ndcgAtK(found, 5)).toBeCloseTo(1.5 / ideal2, 12);
    expect(ndcgAtK(found, 5)).toBeCloseTo(0.91972, 5);
  });

  it("at k = 2, where only A is found", () => {
    expect(hitAtK(found, 2)).toBe(1);
    expect(precisionAtK(found, 2)).toBeCloseTo(1 / 2, 12);
    expect(recallAtK(found, 2)).toBeCloseTo(1 / 2, 12);
    // DCG = 1, best possible with 2 slots and 2 passages = 1.6309
    expect(ndcgAtK(found, 2)).toBeCloseTo(1 / ideal2, 12);
    expect(ndcgAtK(found, 2)).toBeCloseTo(0.61315, 5);
  });

  it("at k = 1", () => {
    expect(precisionAtK(found, 1)).toBe(1);
    expect(recallAtK(found, 1)).toBeCloseTo(1 / 2, 12);
    // one slot, so the best possible is also 1
    expect(ndcgAtK(found, 1)).toBe(1);
  });

  it("a first relevant result at rank 3 gives 1/3, and nothing if the cutoff is before it", () => {
    const late = judgeRetrieval([result(0, 10), result(20, 30), result(110, 120)], [A]);
    expect(reciprocalRank(late)).toBeCloseTo(1 / 3, 12);
    expect(reciprocalRank(late, 3)).toBeCloseTo(1 / 3, 12);
    expect(reciprocalRank(late, 2)).toBe(0);
    expect(hitAtK(late, 2)).toBe(0);
    expect(recallAtK(late, 2)).toBe(0);
    expect(ndcgAtK(late, 2)).toBe(0);
    // DCG = 1/log2(4) = 0.5, best possible with one passage = 1
    expect(ndcgAtK(late, 3)).toBeCloseTo(0.5, 12);
    expect(precisionAtK(late, 3)).toBeCloseTo(1 / 3, 12);
  });

  it("scores 0 everywhere when nothing relevant is found", () => {
    const none = judgeRetrieval([result(0, 10), result(20, 30)], [A]);
    expect(retrievalMetrics(none, 5)).toEqual({
      k: 5,
      hit: 0,
      precision: 0,
      recall: 0,
      mrr: 0,
      ndcg: 0,
    });
  });

  it("scores 0 for an empty result", () => {
    const empty = judgeRetrieval([], [A]);
    expect(retrievalMetrics(empty, 3)).toEqual({
      k: 3,
      hit: 0,
      precision: 0,
      recall: 0,
      mrr: 0,
      ndcg: 0,
    });
    expect(reciprocalRank(empty)).toBe(0);
  });

  it("divides precision by k when fewer results came back", () => {
    const one = judgeRetrieval([result(100, 150)], [A]);
    expect(precisionAtK(one, 5)).toBeCloseTo(1 / 5, 12);
    expect(recallAtK(one, 5)).toBe(1);
  });

  it("counts a second chunk over the same passage as relevant, but not as new", () => {
    const twice = judgeRetrieval([result(90, 130), result(120, 160)], [A]);
    expect(precisionAtK(twice, 2)).toBe(1);
    expect(recallAtK(twice, 2)).toBe(1);
    // DCG = 1 (the second chunk adds nothing), best possible = 1: not above 1
    expect(ndcgAtK(twice, 2)).toBe(1);
  });

  it("finds 2 of 3 passages: recall 2/3, and a perfect order is still nDCG 1", () => {
    const C: GoldPassage = { docId: DOC, span: { start: 700, end: 750 } };
    const two = judgeRetrieval([result(100, 150), result(400, 450)], [A, B, C]);
    expect(recallAtK(two, 2)).toBeCloseTo(2 / 3, 12);
    expect(ndcgAtK(two, 2)).toBe(1);
    // at k = 3 the best possible is 1 + 0.6309 + 0.5, so two found is lower
    expect(ndcgAtK(two, 3)).toBeCloseTo(ideal2 / (ideal2 + 0.5), 12);
  });

  it.each([0, -1, 1.5, Number.NaN])("rejects k = %s as INVALID_ARGUMENT", (k) => {
    for (const metric of [hitAtK, precisionAtK, recallAtK, ndcgAtK, retrievalMetrics]) {
      expect(() => metric(found, k)).toThrowError(
        expect.objectContaining({ code: "INVALID_ARGUMENT" }) as Error,
      );
    }
    expect(() => reciprocalRank(found, k)).toThrowError(
      expect.objectContaining({ code: "INVALID_ARGUMENT" }) as Error,
    );
  });
});

describe("properties that must hold for any ranking", () => {
  function random(seed: number): () => number {
    let state = seed;
    return () => {
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it("keeps every metric in 0..1, and hit and recall never fall as k grows", () => {
    const next = random(11);
    const gold: GoldPassage[] = [A, B, { docId: DOC, span: { start: 700, end: 760 } }];
    for (let trial = 0; trial < 200; trial += 1) {
      const results = Array.from({ length: 12 }, () => {
        const start = Math.floor(next() * 900);
        return result(start, start + 1 + Math.floor(next() * 80));
      });
      const judgement = judgeRetrieval(results, gold);
      let hit = 0;
      let recall = 0;
      for (let k = 1; k <= 12; k += 1) {
        const m = retrievalMetrics(judgement, k);
        for (const value of [m.hit, m.precision, m.recall, m.mrr, m.ndcg]) {
          expect(value).toBeGreaterThanOrEqual(0);
          expect(value).toBeLessThanOrEqual(1 + 1e-12);
        }
        expect(m.hit).toBeGreaterThanOrEqual(hit);
        expect(m.recall).toBeGreaterThanOrEqual(recall);
        ({ hit, recall } = m);
      }
    }
  });
});

describe("scoreRetrieval", () => {
  it("scores each cutoff, in the order asked", () => {
    const scores = scoreRetrieval([result(90, 160), result(420, 430)], [A, B], [1, 5, 2]);
    expect(scores.map((s) => s.k)).toEqual([1, 5, 2]);
    expect(scores.map((s) => s.recall)).toEqual([0.5, 1, 1]);
  });
});

describe("meanMetrics", () => {
  const rank5 = (results: RetrievedChunk[], gold: GoldPassage[]) =>
    retrievalMetrics(judgeRetrieval(results, gold), 5);

  it("averages every metric over the questions, each counting the same", () => {
    // question 1 (hand-worked above): hit 1, precision 0.4, recall 1, mrr 1, ndcg 0.91972
    const q1 = rank5([result(90, 160), result(200, 260), result(420, 430)], [A, B]);
    // question 2: first relevant at rank 3: hit 1, precision 0.2, recall 1, mrr 1/3, ndcg 0.5
    const q2 = rank5([result(0, 10), result(20, 30), result(110, 120)], [A]);
    const mean = meanMetrics([q1, q2]);
    expect(mean.questions).toBe(2);
    expect(mean.k).toBe(5);
    expect(mean.hit).toBe(1);
    expect(mean.precision).toBeCloseTo((2 / 5 + 1 / 5) / 2, 12); // (0.4 + 0.2) / 2
    expect(mean.recall).toBe(1);
    expect(mean.mrr).toBeCloseTo((1 + 1 / 3) / 2, 12);
    expect(mean.ndcg).toBeCloseTo((1.5 / (1 + 1 / log2(3)) + 0.5) / 2, 12);
  });

  it("refuses no questions", () => {
    expect(() => meanMetrics([])).toThrowError(
      expect.objectContaining({ code: "INVALID_ARGUMENT" }) as Error,
    );
  });

  it("refuses scores taken at different cutoffs", () => {
    const judgement = judgeRetrieval([result(100, 150)], [A]);
    expect(() =>
      meanMetrics([retrievalMetrics(judgement, 3), retrievalMetrics(judgement, 5)]),
    ).toThrowError(/different cutoffs/);
  });
});

describe("goldPassages", () => {
  const doc = makeDocument(["First page about cats.\nCats purr.", "Second page about dogs."]);
  const question = (gold: Question["gold"]): Question => ({
    id: "q001",
    question: "What do cats do?",
    kind: "factual",
    answer: "They purr.",
    gold,
  });

  it("turns each page and quote into a span of the document text", () => {
    const passages = goldPassages(
      doc,
      question([
        { page: 1, quote: "Cats purr." },
        { page: 2, quote: "about dogs." },
      ]),
    );
    expect(passages.map((p) => doc.text.slice(p.span.start, p.span.end))).toEqual([
      "Cats purr.",
      "about dogs.",
    ]);
    expect(passages.every((p) => p.docId === doc.id)).toBe(true);
  });

  it("names the question when a quote cannot be found", () => {
    expect(() =>
      goldPassages(doc, question([{ page: 1, quote: "not on this page" }])),
    ).toThrowError(/q001.*does not contain/s);
  });
});

import { describe, expect, it } from "vitest";
import { candidate } from "./fixtures.js";
import {
  budgetShare,
  describeFate,
  describeMove,
  describeUsage,
  formatMs,
  formatScore,
  pagesLabel,
  rerankChangedAnything,
  rerankMove,
  summaryPairs,
} from "./inspector-logic.js";

describe("rerankMove", () => {
  it("is up when the reranker put the chunk earlier", () => {
    expect(rerankMove(candidate({ rank: 5, finalRank: 2 }))).toEqual({
      kind: "up",
      from: 5,
      to: 2,
    });
  });

  it("is down when it put it later", () => {
    expect(rerankMove(candidate({ rank: 1, finalRank: 4 }))).toEqual({
      kind: "down",
      from: 1,
      to: 4,
    });
  });

  it("is same when the place did not change", () => {
    expect(rerankMove(candidate({ rank: 3, finalRank: 3 }))).toEqual({ kind: "same", rank: 3 });
  });

  it("is cut when the reranker dropped the chunk", () => {
    expect(rerankMove(candidate({ finalRank: null, finalScore: null, fate: "cut" }))).toEqual({
      kind: "cut",
    });
  });
});

describe("describeMove", () => {
  it.each([
    [{ kind: "up", from: 5, to: 2 }, "Moved up from place 5 to 2"],
    [{ kind: "down", from: 1, to: 4 }, "Moved down from place 1 to 4"],
    [{ kind: "same", rank: 3 }, "Kept at place 3"],
    [{ kind: "cut" }, "Dropped by the reranker"],
  ] as const)("%j is %s", (move, words) => {
    expect(describeMove(move)).toBe(words);
  });
});

describe("rerankChangedAnything", () => {
  it("is false when every chunk kept its place", () => {
    expect(
      rerankChangedAnything([
        candidate({ rank: 1, finalRank: 1 }),
        candidate({ rank: 2, finalRank: 2 }),
      ]),
    ).toBe(false);
  });

  it("is true when one chunk moved or was cut", () => {
    expect(rerankChangedAnything([candidate({ rank: 1, finalRank: 2 })])).toBe(true);
    expect(rerankChangedAnything([candidate({ finalRank: null })])).toBe(true);
  });

  it("is false for no chunks", () => {
    expect(rerankChangedAnything([])).toBe(false);
  });
});

describe("describeFate", () => {
  it("names the number a used chunk has in the prompt", () => {
    expect(describeFate(candidate({ fate: "used", source: 2 }))).toBe("In the prompt as [2]");
  });

  it("still says a used chunk is in the prompt when no number came with it", () => {
    expect(describeFate(candidate({ fate: "used", source: undefined }))).toBe("In the prompt");
  });

  it.each([
    ["duplicate", "Left out: a duplicate"],
    ["over-budget", "Left out: over the token budget"],
    ["cut", "Not used: cut by the reranker"],
  ] as const)("says why a %s chunk did not reach the prompt", (fate, words) => {
    expect(describeFate(candidate({ fate }))).toBe(words);
  });
});

describe("formatScore", () => {
  it.each([
    [0, "0"],
    [0.0312, "0.031"],
    [0.9123, "0.91"],
    [7.5, "7.50"],
    [3.2, "3.20"],
    [-2.346, "-2.35"],
    [123.456, "123.5"],
  ])("%d is %s", (score, text) => {
    expect(formatScore(score)).toBe(text);
  });
});

describe("pagesLabel", () => {
  it("is one page or a range", () => {
    expect(pagesLabel({ pageStart: 4, pageEnd: 4 })).toBe("p. 4");
    expect(pagesLabel({ pageStart: 4, pageEnd: 6 })).toBe("pp. 4–6");
  });
});

describe("budgetShare", () => {
  const prompt = (sourceTokens: number, budget: number) => ({
    version: "v",
    system: "",
    user: "",
    sourceTokens,
    budget,
    sent: true,
  });

  it("is the part of the budget the sources took", () => {
    expect(budgetShare(prompt(80, 100))).toBe(0.8);
    expect(budgetShare(prompt(0, 100))).toBe(0);
  });

  it("never goes past full", () => {
    expect(budgetShare(prompt(150, 100))).toBe(1);
  });

  it("is full for a budget of nothing, rather than not a number", () => {
    expect(budgetShare(prompt(0, 0))).toBe(1);
  });
});

describe("summaryPairs", () => {
  it("lists the keys of a stage in order, with a dash for null", () => {
    const stage = {
      stage: "rerank",
      startMs: 0,
      durationMs: 1,
      status: "ok" as const,
      summary: { reranker: "llm", kept: 5, reordered: true, finishReason: null },
    };
    expect(summaryPairs(stage)).toEqual([
      ["reranker", "llm"],
      ["kept", "5"],
      ["reordered", "true"],
      ["finishReason", "–"],
    ]);
  });
});

describe("formatMs", () => {
  it.each([
    [0.25, "0.3 ms"],
    [9.94, "9.9 ms"],
    [42.4, "42 ms"],
    [999.4, "999 ms"],
    [1500, "1.5 s"],
  ])("%d is %s", (ms, text) => {
    expect(formatMs(ms)).toBe(text);
  });
});

describe("describeUsage", () => {
  const usage = { calls: 2, promptTokens: 900, outputTokens: 60, embeddedTokens: 10, modelMs: 800 };

  it("is empty when nothing was called", () => {
    expect(describeUsage(undefined)).toBe("");
  });

  it("counts calls and tokens", () => {
    expect(describeUsage(usage)).toBe("2 calls · 900 prompt tokens · 60 answer tokens");
    expect(describeUsage({ ...usage, calls: 1 })).toContain("1 call ·");
  });

  it("adds the cost when the server has prices", () => {
    expect(
      describeUsage({ ...usage, cost: { amount: 0.00123, currency: "USD", unpricedTokens: 0 } }),
    ).toBe("2 calls · 900 prompt tokens · 60 answer tokens · 0.0012 USD");
  });
});

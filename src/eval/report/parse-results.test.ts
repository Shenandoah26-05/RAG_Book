import { describe, expect, it } from "vitest";
import { parseResults, parseSummary } from "./parse-results.js";
import { makeRun } from "./report.testing.js";

const { results, summary } = makeRun(
  {
    a: {
      ndcg: [0.5, undefined, 0.75],
      correctness: [1, undefined, 0.5],
      tokens: { prompt: 5, output: 1 },
    },
  },
  { generation: true },
);
const jsonl = (items: readonly unknown[]): string => items.map((r) => JSON.stringify(r)).join("\n");

describe("parseResults", () => {
  it("reads what the store wrote", () => {
    expect(parseResults(`${jsonl(results)}\n`)).toEqual(results);
  });

  it("accepts a run that was stopped half-way, blank lines and no final newline", () => {
    expect(parseResults("")).toEqual([]);
    expect(parseResults(`\n${jsonl(results.slice(0, 2))}\n\n`)).toEqual(results.slice(0, 2));
  });

  it("names the line that is not JSON", () => {
    const text = `${jsonl(results.slice(0, 1))}\n{"cut off`;
    expect(() => parseResults(text)).toThrow(/line 2 is not JSON/);
  });

  it("names the line that is not a result, and the field", () => {
    const text = jsonl([results[0], { ...results[1], kind: "mystery" }]);
    expect(() => parseResults(text)).toThrow(/line 2 is not a result: kind/);
    expect(() => parseResults(jsonl([{ ...results[0], retrieval: { hit: 2 } }]))).toThrow(
      /retrieval/,
    );
    expect(() => parseResults(jsonl([{ questionId: "q001" }]))).toThrow(/line 1 is not a result/);
  });

  it("is INVALID_ARGUMENT for every problem", () => {
    expect(() => parseResults("nope")).toThrowError(
      expect.objectContaining({ code: "INVALID_ARGUMENT" }) as Error,
    );
  });
});

describe("parseSummary", () => {
  it("reads what the store wrote", () => {
    expect(parseSummary(JSON.stringify(summary, null, 2))).toEqual(summary);
  });

  it("rejects text that is not JSON, and JSON that is not a summary", () => {
    expect(() => parseSummary("{")).toThrow(/not JSON/);
    expect(() => parseSummary("[]")).toThrow(/not an experiment summary/);
    expect(() =>
      parseSummary(JSON.stringify({ ...summary, variants: [{ variant: "a" }] })),
    ).toThrow(/variants\.0/);
  });
});

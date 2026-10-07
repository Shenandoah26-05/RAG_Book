import { describe, expect, it } from "vitest";
import { describeTokenizerContract } from "../../testing/tokenizer-contract.testing.js";
import { ApproxTokenizer } from "./approx-tokenizer.js";

describeTokenizerContract("ApproxTokenizer", () => new ApproxTokenizer());

describe("ApproxTokenizer", () => {
  const tokenizer = new ApproxTokenizer();

  it("is named approx", () => {
    expect(tokenizer.name).toBe("approx");
  });

  it("counts four characters per token, rounded up", () => {
    expect(tokenizer.count("a")).toBe(1);
    expect(tokenizer.count("abcd")).toBe(1);
    expect(tokenizer.count("abcde")).toBe(2);
    expect(tokenizer.count("a".repeat(400))).toBe(100);
  });

  it("gives the same id to the same four characters", () => {
    const [id] = tokenizer.encode("abcd");
    expect(tokenizer.encode("abcdabcd")).toEqual([id, id]);
  });
});

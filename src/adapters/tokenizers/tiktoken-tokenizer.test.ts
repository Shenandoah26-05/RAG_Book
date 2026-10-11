import { describe, expect, it } from "vitest";
import { describeTokenizerContract } from "../../testing/tokenizer-contract.testing.js";
import { TiktokenTokenizer } from "./tiktoken-tokenizer.js";

describeTokenizerContract("TiktokenTokenizer", () => new TiktokenTokenizer());

describe("TiktokenTokenizer", () => {
  const tokenizer = new TiktokenTokenizer();

  it("is named tiktoken", () => {
    expect(tokenizer.name).toBe("tiktoken");
  });

  it("matches known cl100k_base counts", () => {
    expect(tokenizer.count("hello world")).toBe(2);
    expect(tokenizer.encode("hello world")).toEqual([15339, 1917]);
  });

  it("treats special-token strings as ordinary text", () => {
    expect(tokenizer.count("<|endoftext|>")).toBeGreaterThan(1);
  });
});

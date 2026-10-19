import { describe, expect, it } from "vitest";
import { parseSearchArgs } from "./search-args.js";

describe("parseSearchArgs", () => {
  it("takes the question and nothing else by default", () => {
    expect(parseSearchArgs(["what is a vector?"])).toEqual({
      question: "what is a vector?",
      json: false,
      filter: [],
    });
  });

  it("reads --k, --json, --variant, --chunker, --embedder and the folders, with a space or =", () => {
    expect(
      parseSearchArgs([
        "q",
        "--k",
        "8",
        "--json",
        "--variant=bm25",
        "--chunker",
        "fixed-size",
        "--embedder=ollama:all-minilm",
        "--index-dir",
        "idx",
        "--cache-dir=cache",
      ]),
    ).toEqual({
      question: "q",
      json: true,
      filter: [],
      k: 8,
      variant: "bm25",
      chunker: "fixed-size",
      embedder: "ollama:all-minilm",
      indexDir: "idx",
      cacheDir: "cache",
    });
  });

  it("reads the filter flags into a filter, and does not take their values for the question", () => {
    expect(
      parseSearchArgs(["--chapter", "Chapter 3", "where is it", "--pages", "10-20", "--doc=abc"]),
    ).toMatchObject({
      question: "where is it",
      filter: [
        { kind: "equals", field: "docId", value: "abc" },
        { kind: "section", path: ["Chapter 3"] },
        { kind: "pageRange", from: 10, to: 20 },
      ],
    });
  });

  it("skips config overrides and --config, with their values", () => {
    expect(
      parseSearchArgs([
        "--retrieval.strategy",
        "bm25",
        "q",
        "--retrieval.k=3",
        "--config",
        "x.json",
      ]),
    ).toEqual({ question: "q", json: false, filter: [] });
  });

  it("rejects a missing, blank or split question", () => {
    expect(parseSearchArgs([])).toEqual({ error: "No question given" });
    expect(parseSearchArgs(["  "])).toEqual({ error: "No question given" });
    expect(parseSearchArgs(["what", "is"])).toEqual({
      error: 'Unexpected argument "is": put the question in quotes',
    });
  });

  it("rejects a bad --k, a flag without a value, and an unknown option", () => {
    for (const k of ["0", "-1", "x", "1.5"]) {
      expect(parseSearchArgs(["q", "--k", k])).toEqual({
        error: "--k needs a whole number of 1 or more",
      });
    }
    expect(parseSearchArgs(["q", "--variant"])).toEqual({ error: "--variant needs a value" });
    expect(parseSearchArgs(["q", "--chunker", "--json"])).toEqual({
      error: "--chunker needs a value",
    });
    expect(parseSearchArgs(["q", "--nope"])).toEqual({ error: "Unknown option --nope" });
  });

  it("reports a bad filter", () => {
    expect(parseSearchArgs(["q", "--pages", "20-10"])).toMatchObject({
      error: expect.stringContaining("not a page range") as unknown,
    });
  });

  it("rejects --variant together with --config", () => {
    expect(parseSearchArgs(["q", "--variant", "dense", "--config", "x.json"])).toEqual({
      error: "Use --variant or --config, not both",
    });
  });
});

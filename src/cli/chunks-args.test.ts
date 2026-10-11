import { describe, expect, it } from "vitest";
import { parseChunksArgs } from "./chunks-args.js";

describe("parseChunksArgs", () => {
  it("takes the document and nothing else by default", () => {
    expect(parseChunksArgs(["book.pdf"])).toEqual({ target: "book.pdf" });
  });

  it("reads --strategy, --samples, --seed and --dir, with a space or =", () => {
    expect(
      parseChunksArgs([
        "--strategy",
        "fixed-size",
        "doc",
        "--samples=5",
        "--seed",
        "7",
        "--dir=out",
      ]),
    ).toEqual({ target: "doc", strategy: "fixed-size", samples: 5, seed: 7, dir: "out" });
  });

  it("accepts 0 samples", () => {
    expect(parseChunksArgs(["doc", "--samples", "0"])).toEqual({ target: "doc", samples: 0 });
  });

  it("skips config overrides and --config, with their values", () => {
    expect(
      parseChunksArgs([
        "--chunking.max-tokens",
        "200",
        "doc",
        "--chunking.overlap-tokens=10",
        "--config",
        "my.json",
      ]),
    ).toEqual({ target: "doc" });
  });

  it("reports what is wrong", () => {
    expect(parseChunksArgs([])).toEqual({ error: "No document given" });
    expect(parseChunksArgs(["doc", "--strategy"])).toEqual({ error: "--strategy needs a value" });
    expect(parseChunksArgs(["doc", "--strategy", "--seed"])).toEqual({
      error: "--strategy needs a value",
    });
    expect(parseChunksArgs(["doc", "--samples", "many"])).toEqual({
      error: "--samples needs a whole number",
    });
    expect(parseChunksArgs(["doc", "--seed", "-1"])).toEqual({
      error: "--seed needs a whole number",
    });
    expect(parseChunksArgs(["doc", "--force"])).toEqual({ error: "Unknown option --force" });
    expect(parseChunksArgs(["a", "b"])).toEqual({
      error: 'Unexpected argument "b": chunks takes one document',
    });
  });
});

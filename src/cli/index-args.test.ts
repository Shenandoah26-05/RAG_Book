import { describe, expect, it } from "vitest";
import { parseIndexArgs } from "./index-args.js";

describe("parseIndexArgs", () => {
  it("indexes every document by default", () => {
    expect(parseIndexArgs([])).toEqual({ targets: [], force: false });
  });

  it("reads the chunker and embedder, with a space or =", () => {
    expect(parseIndexArgs(["--chunker", "recursive", "--embedder=ollama:all-minilm"])).toEqual({
      targets: [],
      force: false,
      chunker: "recursive",
      embedder: "ollama:all-minilm",
    });
  });

  it("collects documents, --force and the folders", () => {
    expect(
      parseIndexArgs([
        "a.pdf",
        "--force",
        "b",
        "--processed-dir",
        "p",
        "--index-dir=i",
        "--cache-dir",
        "c",
      ]),
    ).toEqual({
      targets: ["a.pdf", "b"],
      force: true,
      processedDir: "p",
      indexDir: "i",
      cacheDir: "c",
    });
  });

  it("skips config overrides and --config, with their values", () => {
    expect(
      parseIndexArgs([
        "--chunking.max-tokens",
        "200",
        "--embedding.batch-size=8",
        "--config",
        "x.json",
        "doc",
      ]),
    ).toEqual({ targets: ["doc"], force: false });
  });

  it("rejects a flag without a value", () => {
    expect(parseIndexArgs(["--chunker"])).toEqual({ error: "--chunker needs a value" });
    expect(parseIndexArgs(["--embedder", "--force"])).toEqual({
      error: "--embedder needs a value",
    });
  });

  it("rejects an unknown option", () => {
    expect(parseIndexArgs(["--nope"])).toEqual({ error: "Unknown option --nope" });
  });
});

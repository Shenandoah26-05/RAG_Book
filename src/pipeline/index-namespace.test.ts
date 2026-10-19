import { describe, expect, it } from "vitest";
import { indexNamespace } from "./index-namespace.js";

describe("indexNamespace", () => {
  it("joins the chunker and the embedder with two underscores", () => {
    expect(indexNamespace("recursive", "ollama:all-minilm")).toBe("recursive__ollama-all-minilm");
  });

  it("replaces characters that are not safe in a file name", () => {
    expect(indexNamespace("a/b", "ollama:nomic embed:latest")).toBe(
      "a-b__ollama-nomic-embed-latest",
    );
  });

  it("is different for different chunkers and embedders", () => {
    const names = new Set([
      indexNamespace("recursive", "ollama:all-minilm"),
      indexNamespace("fixed-size", "ollama:all-minilm"),
      indexNamespace("recursive", "ollama:other"),
    ]);
    expect(names.size).toBe(3);
  });
});

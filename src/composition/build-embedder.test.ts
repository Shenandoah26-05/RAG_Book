import { describe, expect, it } from "vitest";
import { buildEmbedder, embedderNames, parseEmbedderSpec } from "./build-embedder.js";

describe("parseEmbedderSpec", () => {
  it("splits provider and model at the first colon", () => {
    expect(parseEmbedderSpec("ollama:all-minilm")).toEqual({
      provider: "ollama",
      model: "all-minilm",
    });
    expect(parseEmbedderSpec("ollama:all-minilm:latest")).toEqual({
      provider: "ollama",
      model: "all-minilm:latest",
    });
  });

  it.each(["", "ollama", "ollama:", ":model"])("rejects %j", (spec) => {
    expect(() => parseEmbedderSpec(spec)).toThrow(/provider:model/);
  });
});

describe("buildEmbedder", () => {
  it("builds the embedder for a known model, with its model id and vector length", () => {
    const embedder = buildEmbedder("ollama:all-minilm", { batchSize: 8, env: {} });
    expect(embedder.modelId).toBe("ollama:all-minilm");
    expect(embedder.dimensions).toBe(384);
  });

  it("names the embedders that exist for an unknown provider or model", () => {
    expect(embedderNames()).toContain("ollama:all-minilm");
    expect(() => buildEmbedder("openai:x", { batchSize: 8, env: {} })).toThrow(
      /Unknown embedding provider "openai".*ollama:all-minilm/,
    );
    expect(() => buildEmbedder("ollama:mystery", { batchSize: 8, env: {} })).toThrow(
      /Unknown embedding model "mystery".*ollama:all-minilm/,
    );
  });
});

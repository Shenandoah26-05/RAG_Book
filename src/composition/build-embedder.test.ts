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

describe("buildEmbedder: openai-compatible", () => {
  const build = (spec: string, env: Record<string, string> = {}) =>
    buildEmbedder(spec, { batchSize: 8, env, cacheDir: "data/cache/test-unused" });

  it("knows OpenAI's embedding models and their vector lengths", () => {
    expect(embedderNames()).toContain("openai-compatible:text-embedding-3-small");
    const embedder = build("openai-compatible:text-embedding-3-small");
    expect(embedder.modelId).toBe("openai-compatible:text-embedding-3-small");
    expect(embedder.dimensions).toBe(1536);
  });

  it("takes the vector length of another model from OPENAI_EMBEDDING_DIMENSIONS", () => {
    const embedder = build("openai-compatible:nomic-embed-text", {
      OPENAI_EMBEDDING_DIMENSIONS: "768",
    });
    expect(embedder.dimensions).toBe(768);
  });

  it("asks for OPENAI_EMBEDDING_DIMENSIONS when the model is not known, and checks it", () => {
    expect(() => build("openai-compatible:nomic-embed-text")).toThrow(
      /Set OPENAI_EMBEDDING_DIMENSIONS/,
    );
    expect(() => build("openai-compatible:x", { OPENAI_EMBEDDING_DIMENSIONS: "many" })).toThrow(
      /whole number/,
    );
  });
});

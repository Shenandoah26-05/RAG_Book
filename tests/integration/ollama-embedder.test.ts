import { describe, expect, it } from "vitest";
import type { Embedder } from "../../src/core/index.js";
import { ALL_MINILM_DIMENSIONS, OllamaEmbedder } from "../../src/adapters/embedders/index.js";
import { OllamaHost, normalizeOllamaHost } from "../../src/adapters/ollama/index.js";
import { describeEmbedderContract } from "../../src/testing/embedder-contract.testing.js";

// Runs against a real Ollama with all-minilm installed (`ollama pull all-minilm`), and is skipped
// otherwise, so the suite passes on a machine or CI runner without Ollama.
const host = new OllamaHost(normalizeOllamaHost(process.env.OLLAMA_HOST));
const available = await host
  .listModels()
  .then((models) => models.some((name) => name.startsWith("all-minilm")))
  .catch(() => false);

const make = (): Embedder =>
  new OllamaEmbedder({
    address: host.address,
    model: "all-minilm",
    dimensions: ALL_MINILM_DIMENSIONS,
  });

describe.skipIf(!available)("OllamaEmbedder against a real Ollama (all-minilm)", () => {
  describeEmbedderContract("OllamaEmbedder (real all-minilm)", make);

  it("puts related sentences closer together than unrelated ones", async () => {
    const [cat, kitten, tax] = await make().embed(
      ["The cat sat on the mat.", "A kitten rests on the rug.", "Quarterly tax returns are due."],
      "document",
    );
    if (cat === undefined || kitten === undefined || tax === undefined) {
      throw new Error("expected three vectors");
    }
    // vectors are unit length, so the dot product is the cosine similarity
    const dot = (a: Float32Array, b: Float32Array): number =>
      a.reduce((sum, x, i) => sum + x * (b[i] ?? 0), 0);
    expect(dot(cat, kitten)).toBeGreaterThan(dot(cat, tax));
  });
});

it.skipIf(available)("is skipped: Ollama with all-minilm is not running", () => {
  expect(available).toBe(false);
});

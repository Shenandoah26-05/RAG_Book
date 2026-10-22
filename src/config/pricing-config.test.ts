import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, resolveConfig } from "./index.js";

describe("the pricing section", () => {
  it("lists no model by default: the default models run locally", () => {
    expect(DEFAULT_CONFIG.pricing).toEqual({ currency: "USD", models: {} });
  });

  it("takes a price per million tokens for each model id, from a file", () => {
    const config = resolveConfig({
      file: {
        pricing: {
          currency: "EUR",
          models: {
            "openai-compatible:gpt-4o-mini": { inputPerMillion: 0.15, outputPerMillion: 0.6 },
            "ollama:llama3.2": { inputPerMillion: 0, outputPerMillion: 0 },
          },
        },
      },
    });
    expect(config.pricing.currency).toBe("EUR");
    expect(config.pricing.models["openai-compatible:gpt-4o-mini"]).toEqual({
      inputPerMillion: 0.15,
      outputPerMillion: 0.6,
    });
    expect(Object.keys(config.pricing.models)).toHaveLength(2);
  });

  it("can change the currency from the command line", () => {
    expect(resolveConfig({ argv: ["--pricing.currency", "GBP"] }).pricing.currency).toBe("GBP");
  });

  it.each([
    [
      { pricing: { models: { m: { inputPerMillion: -1, outputPerMillion: 0 } } } },
      /inputPerMillion/,
    ],
    [{ pricing: { models: { m: { inputPerMillion: 1 } } } }, /outputPerMillion/],
    [
      { pricing: { models: { m: { inputPerMillion: "cheap", outputPerMillion: 0 } } } },
      /inputPerMillion/,
    ],
    [
      { pricing: { models: { m: { inputPerMillion: 1, outputPerMillion: 1, extra: 1 } } } },
      /extra/,
    ],
    [{ pricing: { currency: "" } }, /currency/],
    [{ pricing: { cost: 1 } }, /cost/],
  ])("rejects %j", (file, message) => {
    expect(() => resolveConfig({ file })).toThrow(message);
  });
});

import { describe, expect, it } from "vitest";
import { expandVariants, MAX_VARIANTS } from "./expand-variants.js";

const names = (input: unknown) => expandVariants(input).variants.map((v) => v.name);

describe("expandVariants", () => {
  it("takes written-out variants as they are, on top of the base", () => {
    const { variants, experiment } = expandVariants({
      name: "e",
      base: { chunking: { strategy: "recursive", maxTokens: 400 } },
      variants: [
        { name: "small", config: { chunking: { maxTokens: 200 } } },
        { name: "plain", config: {} },
      ],
    });
    expect(experiment.generation).toBe(false);
    expect(experiment.dataset).toBe("evals/datasets/v1.jsonl");
    expect(variants).toEqual([
      {
        name: "small",
        settings: { chunking: { maxTokens: 200 } },
        config: { chunking: { strategy: "recursive", maxTokens: 200 } },
      },
      {
        name: "plain",
        settings: {},
        config: { chunking: { strategy: "recursive", maxTokens: 400 } },
      },
    ]);
  });

  it("makes one variant per combination of the matrix, first axis varying slowest", () => {
    const { variants } = expandVariants({
      name: "e",
      matrix: { "retrieval.strategy": ["dense", "bm25"], "retrieval.k": [3, 5] },
    });
    expect(variants.map((v) => v.name)).toEqual([
      "retrieval.strategy=dense+retrieval.k=3",
      "retrieval.strategy=dense+retrieval.k=5",
      "retrieval.strategy=bm25+retrieval.k=3",
      "retrieval.strategy=bm25+retrieval.k=5",
    ]);
    expect(variants[1]).toMatchObject({
      settings: { retrieval: { strategy: "dense", k: 5 } },
      config: { retrieval: { strategy: "dense", k: 5 } },
    });
  });

  it("puts base under the matrix, and a variant's own config over everything", () => {
    const { variants } = expandVariants({
      name: "e",
      base: { retrieval: { strategy: "hybrid", k: 5 }, rerank: { enabled: false } },
      matrix: { "retrieval.k": [3] },
      variants: [{ name: "v", config: { retrieval: { k: 9 } } }],
    });
    expect(variants.map((v) => v.config)).toEqual([
      { retrieval: { strategy: "hybrid", k: 9 }, rerank: { enabled: false } },
      { retrieval: { strategy: "hybrid", k: 3 }, rerank: { enabled: false } },
    ]);
  });

  it("writes booleans and numbers into the name and keeps their type in the config", () => {
    const { variants } = expandVariants({ name: "e", matrix: { "rerank.enabled": [false, true] } });
    expect(variants.map((v) => v.name)).toEqual(["rerank.enabled=false", "rerank.enabled=true"]);
    expect(variants[1]?.config).toEqual({ rerank: { enabled: true } });
  });

  it("makes names that are safe in a file name", () => {
    const [name] = names({ name: "e", matrix: { "embedding.model": ["all minilm:v2/x"] } });
    expect(name).toBe("embedding.model=all-minilm-v2-x");
  });

  it("does not change the experiment it was given", () => {
    const input = { name: "e", base: { a: { b: 1 } }, matrix: { "a.b": [2] } };
    const copy = structuredClone(input);
    expandVariants(input);
    expect(input).toEqual(copy);
  });

  it("rejects an experiment with nothing to run", () => {
    expect(() => expandVariants({ name: "e" })).toThrow(/at least one variant/);
    expect(() => expandVariants({ name: "e", variants: [], matrix: {} })).toThrow(
      /at least one variant/,
    );
  });

  it.each([
    [{ name: "E", variants: [{ name: "v", config: {} }] }, /name/],
    [{ name: "e", variants: [{ name: "has space", config: {} }] }, /variants\.0\.name/],
    [{ name: "e", matrix: { retrieval: [1] } }, /matrix/],
    [{ name: "e", matrix: { "retrieval.k": [] } }, /matrix/],
    [{ name: "e", matrix: { "retrieval.k": [{}] } }, /matrix/],
    [{ name: "e", typo: 1, variants: [{ name: "v", config: {} }] }, /typo|Unrecognized/],
  ])("rejects a malformed experiment %#", (input, message) => {
    expect(() => expandVariants(input)).toThrow(message);
  });

  it("rejects the same name twice, whether written or from the matrix", () => {
    expect(() =>
      expandVariants({
        name: "e",
        variants: [
          { name: "v", config: {} },
          { name: "v", config: {} },
        ],
      }),
    ).toThrow(/Two variants are called "v"/);
    expect(() =>
      expandVariants({
        name: "e",
        variants: [{ name: "retrieval.k=3", config: {} }],
        matrix: { "retrieval.k": [3] },
      }),
    ).toThrow(/Two variants are called "retrieval.k=3"/);
  });

  it("refuses a matrix that is too big", () => {
    const axis = Array.from({ length: 15 }, (_, i) => i);
    expect(axis.length ** 2).toBeGreaterThan(MAX_VARIANTS);
    expect(() =>
      expandVariants({ name: "e", matrix: { "retrieval.k": axis, "chunking.maxTokens": axis } }),
    ).toThrow(/most allowed/);
  });

  it("is INVALID_ARGUMENT for every problem", () => {
    expect(() => expandVariants("nope")).toThrowError(
      expect.objectContaining({ code: "INVALID_ARGUMENT" }) as Error,
    );
  });
});

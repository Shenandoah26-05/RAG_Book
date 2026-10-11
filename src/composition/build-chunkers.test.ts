import { describe, expect, it } from "vitest";
import { fixedWidthTokenizer } from "../testing/fake-tokenizer.testing.js";
import { makeDocument } from "../testing/make-document.testing.js";
import { buildChunker } from "./chunker-registry.js";
import { buildChunkerRegistry } from "./build-chunkers.js";

const registry = buildChunkerRegistry(fixedWidthTokenizer(1));
const doc = makeDocument([
  "The first sentence is here. The second one follows it.\n\nA new paragraph.",
]);

describe("buildChunkerRegistry", () => {
  it("has the fixed-size, recursive and structure-aware strategies", () => {
    expect(registry.names()).toEqual(["fixed-size", "recursive", "structure-aware"]);
  });

  it.each(["fixed-size", "recursive", "structure-aware"])(
    "builds %s from the chunking settings, and it chunks a document",
    async (strategy) => {
      const chunker = buildChunker({ strategy, maxTokens: 30, overlapTokens: 5 }, registry);
      expect(chunker.name).toBe(strategy);
      const chunks = await chunker.chunk(doc);
      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks.every((chunk) => chunk.metadata.strategy === strategy)).toBe(true);
    },
  );

  it("rejects an unknown strategy, naming the ones that exist", () => {
    expect(() =>
      buildChunker({ strategy: "magic", maxTokens: 30, overlapTokens: 5 }, registry),
    ).toThrow(/Known strategies: fixed-size, recursive, structure-aware/);
  });
});

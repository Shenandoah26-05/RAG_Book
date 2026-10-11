import type { Tokenizer } from "../core/index.js";
import { FixedSizeChunker, RecursiveChunker, StructureAwareChunker } from "../strategies/index.js";
import { ChunkerRegistry } from "./chunker-registry.js";

/**
 * The registry with every chunking strategy there is. Adding a strategy is one new class and one
 * `register` call here. All strategies measure size with the same `tokenizer`, so sizes mean the
 * same thing whichever one is chosen.
 */
export function buildChunkerRegistry(tokenizer: Tokenizer): ChunkerRegistry {
  return new ChunkerRegistry()
    .register(
      "fixed-size",
      ({ settings }) => new FixedSizeChunker(tokenizer, settings.maxTokens, settings.overlapTokens),
    )
    .register(
      "recursive",
      ({ settings }) =>
        new RecursiveChunker({
          maxTokens: settings.maxTokens,
          overlapTokens: settings.overlapTokens,
          count: (text) => tokenizer.count(text),
        }),
    )
    .register(
      "structure-aware",
      (context) =>
        new StructureAwareChunker({
          inner: context.create("recursive"),
          tokenizer,
          maxTokens: context.settings.maxTokens,
        }),
    );
}

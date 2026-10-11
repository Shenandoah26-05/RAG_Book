import type { CharSpan, Chunk, Chunker, ParsedDocument } from "../../core/index.js";
import { RagError } from "../../shared/index.js";
import { createChunk } from "./chunk-builder.js";
import {
  DEFAULT_SEPARATORS,
  packGroups,
  splitRecursive,
  type TokenCounter,
} from "./recursive-split.js";

export interface RecursiveChunkerOptions {
  /** Most tokens a chunk may hold. */
  readonly maxTokens: number;
  /** Tokens repeated from the end of one chunk at the start of the next. Must be below maxTokens. */
  readonly overlapTokens: number;
  /** How many tokens a text has; the composition root passes the tokenizer's `count`. */
  readonly count: TokenCounter;
  /** Biggest separator first. Defaults to paragraphs, lines, sentences, words. */
  readonly separators?: readonly string[];
}

const WHITESPACE = /\s/;

/** The span without whitespace at either end, or undefined if only whitespace is left. */
function trimmed(text: string, span: CharSpan): CharSpan | undefined {
  let { start, end } = span;
  while (start < end && WHITESPACE.test(text.charAt(start))) start += 1;
  while (end > start && WHITESPACE.test(text.charAt(end - 1))) end -= 1;
  return start < end ? { start, end } : undefined;
}

/**
 * Splits on the biggest separator that makes the pieces fit, and falls back to smaller ones for
 * pieces that are still too long (paragraphs, then lines, sentences, words, and finally characters).
 * Neighbouring small pieces are then packed together up to `maxTokens`, so whole paragraphs and
 * sentences stay together whenever they fit.
 *
 * It never leaves a chunk over `maxTokens` (apart from one character that is over it on its own),
 * and never drops text: pieces tile the document and keep the separator that ended them.
 */
export class RecursiveChunker implements Chunker {
  readonly name = "recursive";
  readonly #options: Required<RecursiveChunkerOptions>;

  constructor(options: RecursiveChunkerOptions) {
    const { maxTokens, overlapTokens } = options;
    const separators = options.separators ?? DEFAULT_SEPARATORS;
    if (!Number.isInteger(maxTokens) || maxTokens < 1) {
      throw new RagError("INVALID_ARGUMENT", `maxTokens must be a whole number of 1 or more`);
    }
    if (!Number.isInteger(overlapTokens) || overlapTokens < 0 || overlapTokens >= maxTokens) {
      throw new RagError(
        "INVALID_ARGUMENT",
        `overlapTokens must be a whole number from 0 up to, not including, maxTokens`,
      );
    }
    if (separators.some((separator) => separator === "")) {
      throw new RagError("INVALID_ARGUMENT", "a separator cannot be an empty string");
    }
    this.#options = { ...options, separators };
  }

  chunk(doc: ParsedDocument): Promise<readonly Chunk[]> {
    const { count, separators, maxTokens, overlapTokens } = this.#options;
    const groups = splitRecursive(doc.text, count, separators, maxTokens);
    const packed = packGroups(doc.text, groups, count, maxTokens, overlapTokens);

    const chunks: Chunk[] = [];
    let lastEnd = 0;
    for (const span of packed) {
      const kept = trimmed(doc.text, span);
      // a span of only whitespace, or one already inside the previous chunk, adds nothing
      if (kept === undefined || kept.end <= lastEnd) continue;
      chunks.push(createChunk(doc, this.name, kept));
      lastEnd = kept.end;
    }
    return Promise.resolve(chunks);
  }
}

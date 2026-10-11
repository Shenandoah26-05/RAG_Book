import type { Chunk, Chunker, ParsedDocument, Tokenizer } from "../../core/index.js";
import { RagError } from "../../shared/index.js";
import { createChunk } from "./chunk-builder.js";

/**
 * The baseline strategy: a window of `size` tokens slides over the text, moving `size - overlap`
 * tokens at a time. It is kept dumb on purpose, with no sentence or paragraph awareness, because it
 * is the control group every other strategy is compared against in the A/B tests.
 *
 * Token windows become character spans through `Tokenizer.tokenSpans`, and `createChunk` does the
 * rest. Each chunk's text is the exact passage, so edges may cut a word when tokens do.
 */
export class FixedSizeChunker implements Chunker {
  readonly name = "fixed-size";

  readonly #tokenizer: Tokenizer;
  readonly #size: number;
  readonly #overlap: number;

  /**
   * @param size tokens per chunk, a whole number of 1 or more
   * @param overlap tokens shared by neighbouring chunks, a whole number from 0 up to `size - 1`
   * @throws RagError CONFIG_INVALID if the sizes break those rules
   */
  constructor(tokenizer: Tokenizer, size: number, overlap: number) {
    if (!Number.isInteger(size) || size < 1) {
      throw new RagError(
        "CONFIG_INVALID",
        `fixed-size: size must be a whole number of 1 or more, got ${String(size)}`,
      );
    }
    if (!Number.isInteger(overlap) || overlap < 0) {
      throw new RagError(
        "CONFIG_INVALID",
        `fixed-size: overlap must be a whole number of 0 or more, got ${String(overlap)}`,
      );
    }
    if (overlap >= size) {
      // the window would never move forward
      throw new RagError(
        "CONFIG_INVALID",
        `fixed-size: overlap (${overlap.toString()}) must be smaller than size (${size.toString()})`,
      );
    }
    this.#tokenizer = tokenizer;
    this.#size = size;
    this.#overlap = overlap;
  }

  chunk(doc: ParsedDocument): Promise<readonly Chunk[]> {
    const tokens = this.#tokenizer.tokenSpans(doc.text);
    const step = this.#size - this.#overlap; // 1 or more, so the loop below always ends
    const chunks: Chunk[] = [];

    for (let first = 0; first < tokens.length; first += step) {
      const last = Math.min(first + this.#size, tokens.length) - 1; // inclusive
      const start = tokens[first]?.start ?? 0;
      const end = tokens[last]?.end ?? doc.text.length;

      // a window of whitespace has nothing to search for, and dropping it loses no text
      if (doc.text.slice(start, end).trim() !== "") {
        chunks.push(createChunk(doc, this.name, { start, end }));
      }
      // this window reaches the end; the next would sit entirely inside it
      if (last === tokens.length - 1) break;
    }
    return Promise.resolve(chunks);
  }
}

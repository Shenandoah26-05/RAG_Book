import type { CharSpan } from "../types/document.js";

/**
 * Counts and splits text in tokens, the unit that model limits and chunk sizes are measured in.
 * Counts are approximations for local models, so the choice of tokenizer sits behind this port.
 *
 * NOTE (RAG-022): `tokenSpans` is what a chunker needs to turn "tokens 100 to 612" into a character
 * span, which is how chunks are tied to the document. `encode` gives token ids, which say nothing
 * about where a token sits in the text. RAG-021 owns this port and must keep `tokenSpans`.
 */
export interface Tokenizer {
  /** The number of tokens in `text`. Equals `encode(text).length` and `tokenSpans(text).length`. */
  count(text: string): number;
  encode(text: string): readonly number[];
  /**
   * Where each token sits in `text`, in order. The spans are contiguous, do not overlap, and
   * together cover the whole string, so whitespace belongs to some token.
   */
  tokenSpans(text: string): readonly CharSpan[];
}

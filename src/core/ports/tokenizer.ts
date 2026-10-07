/**
 * Counts and splits text in tokens, the unit that chunk sizes and prompt budgets are written in.
 * Chunkers and the context assembler receive one through their constructor.
 *
 * Rules every tokenizer must follow (checked by describeTokenizerContract):
 * - `count(text)` equals `encode(text).length`.
 * - The empty string has no tokens.
 * - The same text always gives the same result.
 * - More text never means fewer tokens: `count(a + b) >= count(a)`.
 *
 * Counts are approximations for local models, whose real tokenizers differ from the one used here.
 * Leave a safety margin when a hard limit matters.
 */
export interface Tokenizer {
  /** The name used in config, e.g. "approx". */
  readonly name: string;
  count(text: string): number;
  encode(text: string): readonly number[];
}

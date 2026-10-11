import { getEncoding } from "js-tiktoken";
import type { Tiktoken } from "js-tiktoken";
import type { CharSpan, Tokenizer } from "../../core/index.js";

/**
 * Counts tokens with the cl100k_base vocabulary (js-tiktoken). Exact for OpenAI models and a close
 * estimate for most others, including the local models served by Ollama.
 *
 * The vocabulary loads when the tokenizer is created, not when it is imported.
 */
export class TiktokenTokenizer implements Tokenizer {
  readonly name = "tiktoken";
  private readonly encoding: Tiktoken = getEncoding("cl100k_base");

  count(text: string): number {
    return this.encode(text).length;
  }

  encode(text: string): readonly number[] {
    // Special tokens are neither allowed nor banned, so text that contains a special-token string
    // (e.g. "<|endoftext|>") is encoded as ordinary text instead of throwing or becoming one token.
    return this.encoding.encode(text, [], []);
  }

  tokenSpans(text: string): readonly CharSpan[] {
    const ids = this.encode(text);
    const spans: CharSpan[] = [];
    let position = 0;
    let first = 0; // index of the first token not yet placed
    for (let i = 0; i < ids.length; i++) {
      // A token can hold only part of a character's UTF-8 bytes, which decodes to garbage. Keep
      // adding tokens until the group decodes to the text that really is at `position`.
      const decoded = this.encoding.decode(ids.slice(first, i + 1));
      if (decoded === "" || !text.startsWith(decoded, position)) continue;
      spans.push({ start: position, end: position + decoded.length });
      for (let k = first + 1; k <= i; k++) {
        spans.push({ start: position + decoded.length, end: position + decoded.length });
      }
      position += decoded.length;
      first = i + 1;
    }
    // Normally nothing is left. If decoding did not line up, the rest belongs to the last token.
    const last = spans[spans.length - 1];
    if (last !== undefined && last.end < text.length) {
      spans[spans.length - 1] = { start: last.start, end: text.length };
    }
    return spans;
  }
}

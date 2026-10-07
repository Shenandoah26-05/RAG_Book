import type { Tokenizer } from "../../core/index.js";

const CHARS_PER_TOKEN = 4;

/**
 * Estimates tokens as characters divided by four, rounded up. It needs no vocabulary and is fast,
 * which makes it the default.
 *
 * `encode` has no real vocabulary to use, so each id stands for one window of four characters and
 * is only good for counting: do not decode ids or compare them between different texts.
 */
export class ApproxTokenizer implements Tokenizer {
  readonly name = "approx";

  count(text: string): number {
    return Math.ceil(text.length / CHARS_PER_TOKEN);
  }

  encode(text: string): readonly number[] {
    const ids: number[] = [];
    for (let start = 0; start < text.length; start += CHARS_PER_TOKEN) {
      const end = Math.min(start + CHARS_PER_TOKEN, text.length);
      let id = 0;
      for (let i = start; i < end; i++) id = (id * 31 + text.charCodeAt(i)) >>> 0;
      ids.push(id);
    }
    return ids;
  }
}

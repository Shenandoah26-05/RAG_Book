// Tokenizers for tests, so chunker tests do not depend on the real ones (RAG-021). Not part of the
// build (see tsconfig.build.json).
import type { CharSpan, Tokenizer } from "../core/index.js";

/** Every `size` characters are one token (the last one may be shorter), like ApproxTokenizer. */
export function fixedWidthTokenizer(size = 4): Tokenizer {
  const spans = (text: string): CharSpan[] => {
    const result: CharSpan[] = [];
    for (let start = 0; start < text.length; start += size) {
      result.push({ start, end: Math.min(start + size, text.length) });
    }
    return result;
  };
  return {
    count: (text) => spans(text).length,
    encode: (text) => spans(text).map((_, index) => index),
    tokenSpans: spans,
  };
}

/** A word and the whitespace after it are one token, so token edges fall on word edges. */
export function wordTokenizer(): Tokenizer {
  const spans = (text: string): CharSpan[] =>
    [...text.matchAll(/\S+\s*|\s+/g)].map((m) => ({
      start: m.index,
      end: m.index + m[0].length,
    }));
  return {
    count: (text) => spans(text).length,
    encode: (text) => spans(text).map((_, index) => index),
    tokenSpans: spans,
  };
}

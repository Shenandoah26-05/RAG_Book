import type { CharSpan } from "../../core/index.js";

/** Splits text into sentences and returns where each one sits. Spans never include the whitespace between sentences. */
export type SentenceSplitter = (text: string) => readonly CharSpan[];

/**
 * A deliberately simple splitter: a sentence ends after `.`, `!` or `?` followed by whitespace and
 * a capital letter, digit or quote, and a blank line always ends one. It does not know about
 * abbreviations such as "Dr." ; the sentence splitter of RAG-023 replaces it. Every
 * non-whitespace character ends up in exactly one span.
 */
export const splitSentencesBasic: SentenceSplitter = (text) => {
  const spans: CharSpan[] = [];
  const boundary = /[.!?]["')\]]*\s+(?=["'([]?[\p{Lu}\p{N}])|\n{2,}/gu;
  let start = 0;
  const push = (rawStart: number, rawEnd: number): void => {
    const piece = text.slice(rawStart, rawEnd);
    const leading = piece.length - piece.trimStart().length;
    const trimmed = piece.trim();
    if (trimmed !== "") {
      spans.push({ start: rawStart + leading, end: rawStart + leading + trimmed.length });
    }
  };
  for (const match of text.matchAll(boundary)) {
    const end = match.index + match[0].length;
    push(start, end);
    start = end;
  }
  push(start, text.length);
  return spans;
};

import type { CharSpan } from "../../core/index.js";

// The two pure steps behind the recursive chunker. Both work only in character offsets into one
// string, so they can be tested without a document, a tokenizer or any metadata:
//
//   splitRecursive: cut the text into small pieces, using the biggest separator that works
//   packGroups:     glue neighbouring pieces back together up to maxTokens, with overlap
//
// Pieces always tile the text exactly (no gaps, no overlap), because each piece keeps the separator
// that ended it. That is what lets the chunker promise it never drops a character.
//
// Pieces come in groups. A piece that was too long gets cut on a smaller separator, and the pieces
// that come out form their own groups; packing never glues across groups. Without that, a short
// paragraph would be glued onto the first words of the long paragraph after it, and the long
// paragraph would be cut at a worse place than its own sentence boundaries.

/** How many tokens a text has. Passed in, so this file does not depend on a tokenizer. */
export type TokenCounter = (text: string) => number;

/** Biggest separator first: paragraphs, lines, sentences, then words. */
export const DEFAULT_SEPARATORS: readonly string[] = ["\n\n", "\n", ". ", "? ", "! ", " "];

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;

/** Cuts `[start, end)` after every occurrence of `separator`; the separator stays with the piece before it. */
function cutAfter(text: string, start: number, end: number, separator: string): CharSpan[] {
  const pieces: CharSpan[] = [];
  let from = start;
  for (;;) {
    const at = text.indexOf(separator, from);
    const cut = at + separator.length;
    if (at === -1 || cut >= end) break;
    pieces.push({ start: from, end: cut });
    from = cut;
  }
  pieces.push({ start: from, end });
  return pieces;
}

/**
 * Last resort for text that no separator can split: cut it into the longest runs that fit. A run
 * never ends between the two halves of a surrogate pair. A single character that is over the limit
 * on its own is returned as it is, since it cannot be made smaller.
 */
function cutByLength(
  text: string,
  start: number,
  end: number,
  count: TokenCounter,
  maxTokens: number,
): CharSpan[] {
  const pieces: CharSpan[] = [];
  let from = start;
  while (from < end) {
    // largest length that fits; token counts only grow as text grows, so binary search works
    let low = 1;
    let high = end - from;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (count(text.slice(from, from + middle)) <= maxTokens) low = middle;
      else high = middle - 1;
    }
    let cut = from + low;
    if (cut < end && isHighSurrogate(text.charCodeAt(cut - 1))) {
      cut = cut - 1 > from ? cut - 1 : cut + 1;
    }
    pieces.push({ start: from, end: cut });
    from = cut;
  }
  return pieces;
}

function splitSpan(
  text: string,
  span: CharSpan,
  count: TokenCounter,
  separators: readonly string[],
  maxTokens: number,
): CharSpan[][] {
  if (count(text.slice(span.start, span.end)) <= maxTokens) return [[span]];

  const [separator, ...smaller] = separators;
  if (separator === undefined) {
    return [cutByLength(text, span.start, span.end, count, maxTokens)];
  }
  const pieces = cutAfter(text, span.start, span.end, separator);
  // this separator is not in the text: try the next one on the same span
  if (pieces.length === 1) return splitSpan(text, span, count, smaller, maxTokens);

  const groups: CharSpan[][] = [];
  let fitting: CharSpan[] = [];
  for (const piece of pieces) {
    if (count(text.slice(piece.start, piece.end)) <= maxTokens) {
      fitting.push(piece);
      continue;
    }
    if (fitting.length > 0) groups.push(fitting);
    fitting = [];
    groups.push(...splitSpan(text, piece, count, smaller, maxTokens));
  }
  if (fitting.length > 0) groups.push(fitting);
  return groups;
}

/**
 * Cuts `text` into pieces of at most `maxTokens` tokens each (except a lone character that is over
 * the limit by itself), as groups that may be packed on their own. Text that already fits is one
 * piece. Otherwise it is cut on the first separator, and each piece that is still too long is cut
 * on the next one, and so on. Text left after the last separator is cut by length.
 *
 * Read in order, the pieces cover `[0, text.length)` exactly.
 */
export function splitRecursive(
  text: string,
  count: TokenCounter,
  separators: readonly string[],
  maxTokens: number,
): CharSpan[][] {
  if (text.length === 0) return [];
  return splitSpan(text, { start: 0, end: text.length }, count, separators, maxTokens);
}

/**
 * Glues consecutive pieces into chunks of at most `maxTokens` tokens. The size is measured on the
 * glued text, not by adding up the pieces, since a tokenizer may count them differently together.
 *
 * Each chunk after the first starts with the last whole pieces of the one before, as many as fit in
 * `overlapTokens`, so overlap never cuts a piece in half. Every chunk contains at least one piece
 * the previous one did not, so chunks always move forward.
 */
export function packPieces(
  text: string,
  pieces: readonly CharSpan[],
  count: TokenCounter,
  maxTokens: number,
  overlapTokens: number,
): CharSpan[] {
  const slice = (from: number, to: number): string => {
    const first = pieces[from];
    const last = pieces[to - 1];
    return first === undefined || last === undefined ? "" : text.slice(first.start, last.end);
  };

  const chunks: CharSpan[] = [];
  let from = 0;
  let reached = 0; // pieces before this index are already in an earlier chunk
  while (reached < pieces.length) {
    let to = Math.max(reached + 1, from + 1);
    while (to < pieces.length && count(slice(from, to + 1)) <= maxTokens) to += 1;

    const first = pieces[from];
    const last = pieces[to - 1];
    if (first === undefined || last === undefined) break;
    chunks.push({ start: first.start, end: last.end });
    reached = to;
    if (to >= pieces.length) break;

    // the next chunk starts as late as it must, so that it keeps at most overlapTokens of this one
    // and still has room for the piece that comes next
    let next = from + 1;
    while (
      next < to &&
      (count(slice(next, to)) > overlapTokens || count(slice(next, to + 1)) > maxTokens)
    ) {
      next += 1;
    }
    from = next;
  }
  return chunks;
}

/** `packPieces` on each group in turn: chunks never span two groups, and overlap never crosses one. */
export function packGroups(
  text: string,
  groups: readonly (readonly CharSpan[])[],
  count: TokenCounter,
  maxTokens: number,
  overlapTokens: number,
): CharSpan[] {
  return groups.flatMap((group) => packPieces(text, group, count, maxTokens, overlapTokens));
}

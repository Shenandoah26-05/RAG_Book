const SHINGLE_WORDS = 3;

/** Word triples of the text, lower-cased. A text of fewer than three words is one shingle. */
function shingles(text: string): Set<string> {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length <= SHINGLE_WORDS) return new Set([words.join(" ")]);
  const result = new Set<string>();
  for (let i = 0; i + SHINGLE_WORDS <= words.length; i++) {
    result.add(words.slice(i, i + SHINGLE_WORDS).join(" "));
  }
  return result;
}

/** Share of shingles the two texts have in common, from 0 (nothing) to 1 (the same). */
export function textSimilarity(a: string, b: string): number {
  const left = shingles(a);
  const right = shingles(b);
  let shared = 0;
  for (const shingle of left) if (right.has(shingle)) shared++;
  return shared / (left.size + right.size - shared);
}

export interface DuplicateSplit<T> {
  readonly kept: T[];
  readonly duplicates: T[];
}

/**
 * Drops items whose text is nearly the same as an item that comes before them. Items arrive best
 * first, so of two near-copies the better one stays. Overlapping chunks (a sliding window) share
 * part of their text but are not near-duplicates; only a mostly-shared text counts.
 */
export function removeNearDuplicates<T>(
  bestFirst: readonly T[],
  textOf: (item: T) => string,
  threshold: number,
): DuplicateSplit<T> {
  const kept: T[] = [];
  const keptTexts: string[] = [];
  const duplicates: T[] = [];
  for (const item of bestFirst) {
    const text = textOf(item);
    if (keptTexts.some((other) => textSimilarity(text, other) >= threshold)) duplicates.push(item);
    else {
      kept.push(item);
      keptTexts.push(text);
    }
  }
  return { kept, duplicates };
}

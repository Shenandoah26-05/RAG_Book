/**
 * Common English words that say little about what a passage is about. Optional: pass it (or your
 * own list) as `stopwords` to leave these out of the index and out of queries.
 */
export const ENGLISH_STOPWORDS: readonly string[] = [
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "for",
  "if",
  "in",
  "into",
  "is",
  "it",
  "no",
  "not",
  "of",
  "on",
  "or",
  "such",
  "that",
  "the",
  "their",
  "then",
  "there",
  "these",
  "they",
  "this",
  "to",
  "was",
  "will",
  "with",
];

/** Letters and digits of any script. Everything else, punctuation and spaces alike, separates terms. */
const TERM = /[\p{L}\p{N}]+/gu;
/** Straight and curly apostrophes: "don't" becomes "dont" instead of "don" and "t". */
const APOSTROPHES = /['’]/g;

/**
 * Turns text into the terms BM25 counts: lowercase, punctuation removed, stopwords dropped. The
 * order and repeats are kept, because how often a term occurs is the whole point.
 *
 * - Accents are kept ("café" stays "café"), compatibility forms are folded (NFKC: the ligature
 *   "ﬁ" becomes "fi").
 * - A hyphen separates ("state-of-the-art" is four terms) and so does a dot in a number ("3.2" is
 *   "3" and "2"). No stemming: "embedding" and "embeddings" are different terms.
 * - The same function indexes passages and reads queries, so both sides agree.
 */
export function analyze(text: string, stopwords: ReadonlySet<string> = new Set()): string[] {
  const folded = text.normalize("NFKC").toLowerCase().replace(APOSTROPHES, "");
  const terms = folded.match(TERM) ?? [];
  return stopwords.size === 0 ? terms : terms.filter((term) => !stopwords.has(term));
}

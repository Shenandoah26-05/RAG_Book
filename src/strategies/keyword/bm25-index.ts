import { z } from "zod";
import type {
  Chunk,
  ChunkId,
  ChunkMetadata,
  DocId,
  KeywordIndex,
  MetadataFilter,
  ScoredId,
} from "../../core/index.js";
import { RagError } from "../../shared/index.js";
import { assertValidFilter, matchesFilter, TopK } from "../in-memory-index/index.js";
import { analyze } from "./analyzer.js";

/** Bumped when the serialized layout changes; an index of another version is refused. */
export const BM25_FORMAT_VERSION = 1;

export interface Bm25Options {
  /** How fast repeating a term stops helping. 0 ignores term frequency. Default 1.2. */
  readonly k1?: number;
  /** How much a long passage is discounted: 0 not at all, 1 fully. Default 0.75. */
  readonly b?: number;
  /** Words to leave out, e.g. `ENGLISH_STOPWORDS`. Default: none. */
  readonly stopwords?: readonly string[];
}

/** One indexed chunk. Its terms are not kept: the postings hold them. */
interface Doc {
  readonly id: ChunkId;
  /** How many terms the chunk has (repeats counted). */
  readonly length: number;
  readonly metadata: ChunkMetadata;
}

/** The chunks that contain one term, as parallel arrays: chunk number, and how often. */
interface Postings {
  readonly docs: number[];
  readonly counts: number[];
}

const invalid = (message: string): RagError => new RagError("INVALID_ARGUMENT", message);

const whole = z.number().int().nonnegative();
const serializedSchema = z.strictObject({
  formatVersion: z.number().int(),
  type: z.literal("bm25"),
  k1: z.number().nonnegative(),
  b: z.number().min(0).max(1),
  stopwords: z.array(z.string()),
  docs: z.array(
    z.strictObject({
      id: z.string(),
      length: whole,
      metadata: z.strictObject({
        docId: z.string(),
        pageStart: whole,
        pageEnd: whole,
        sectionPath: z.array(z.string()),
        charStart: whole,
        charEnd: whole,
        strategy: z.string(),
      }),
    }),
  ),
  /** `[term, [chunk number, count, chunk number, count, ...]]`, sorted by term. */
  terms: z.array(z.tuple([z.string(), z.array(whole)])),
});

/**
 * BM25, written by hand: the standard way to rank passages by the words of a query.
 *
 * For a query term `t` and a chunk `d`:
 *
 *   score(d, t) = idf(t) * tf * (k1 + 1) / (tf + k1 * (1 - b + b * len(d) / avglen))
 *   idf(t)      = ln(1 + (N - df + 0.5) / (df + 0.5))
 *
 * and the chunk's score is the sum over the distinct terms of the query.
 *
 * - `tf` is how often `t` occurs in `d`, `df` how many chunks contain `t`, `N` how many chunks
 *   there are, `len(d)` the number of terms in `d` and `avglen` the average of that.
 * - `idf` is the Lucene form: a term in every chunk still counts a little, and it is never
 *   negative, so a match can never lower a score.
 * - `N`, `df` and `avglen` are taken over the whole index, whatever the filter says, so a chunk's
 *   score does not depend on which filter was used.
 * - A search only walks the postings of the query's terms, not every chunk. The best `k` are kept
 *   with the same bounded heap as the flat vector store, and ties are ordered by id.
 */
export class Bm25Index implements KeywordIndex {
  readonly name = "bm25";
  readonly k1: number;
  readonly b: number;
  readonly stopwords: ReadonlySet<string>;
  readonly #docs: Doc[] = [];
  readonly #numbers = new Map<ChunkId, number>();
  readonly #postings = new Map<string, Postings>();
  #totalLength = 0;

  /** @throws RagError INVALID_ARGUMENT if `k1` is negative or `b` is outside 0 to 1 */
  constructor(options: Bm25Options = {}) {
    const { k1 = 1.2, b = 0.75, stopwords = [] } = options;
    if (!Number.isFinite(k1) || k1 < 0) {
      throw invalid(`k1 must be a number of 0 or more, got ${String(k1)}`);
    }
    if (!Number.isFinite(b) || b < 0 || b > 1) {
      throw invalid(`b must be a number from 0 to 1, got ${String(b)}`);
    }
    this.k1 = k1;
    this.b = b;
    // written the way the index will see them, so "The" in the list removes "the" in the text
    this.stopwords = new Set(stopwords.flatMap((word) => analyze(word)));
  }

  count(): number {
    return this.#docs.length;
  }

  add(chunks: readonly Chunk[]): void {
    const seen = new Set<ChunkId>();
    for (const chunk of chunks) {
      if (this.#numbers.has(chunk.id) || seen.has(chunk.id)) {
        throw invalid(`Chunk ${chunk.id} is already in the keyword index`);
      }
      seen.add(chunk.id);
    }
    for (const chunk of chunks) {
      const terms = analyze(chunk.embedText ?? chunk.text, this.stopwords);
      const number = this.#docs.length;
      this.#docs.push({ id: chunk.id, length: terms.length, metadata: chunk.metadata });
      this.#numbers.set(chunk.id, number);
      this.#totalLength += terms.length;

      const frequencies = new Map<string, number>();
      for (const term of terms) frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
      for (const [term, count] of frequencies) {
        let postings = this.#postings.get(term);
        if (postings === undefined) {
          postings = { docs: [], counts: [] };
          this.#postings.set(term, postings);
        }
        postings.docs.push(number);
        postings.counts.push(count);
      }
    }
  }

  search(query: string, k: number, filter: MetadataFilter = []): Promise<readonly ScoredId[]> {
    try {
      const top = new TopK(k);
      assertValidFilter(filter);
      const total = this.#docs.length;
      const average = total === 0 ? 0 : this.#totalLength / total;

      // one score per chunk that shares a term with the query, summed term by term
      const scores = new Map<number, number>();
      const allowed = new Map<number, boolean>();
      for (const term of new Set(analyze(query, this.stopwords))) {
        const postings = this.#postings.get(term);
        if (postings === undefined) continue;
        const df = postings.docs.length;
        const idf = Math.log(1 + (total - df + 0.5) / (df + 0.5));
        postings.docs.forEach((number, i) => {
          const doc = this.#docs[number];
          if (doc === undefined) return;
          let pass = allowed.get(number);
          if (pass === undefined) {
            pass = matchesFilter(doc.metadata, filter);
            allowed.set(number, pass);
          }
          if (!pass) return;
          const tf = postings.counts[i] ?? 0;
          const normalised = 1 - this.b + (this.b * doc.length) / average;
          const part = (idf * tf * (this.k1 + 1)) / (tf + this.k1 * normalised);
          scores.set(number, (scores.get(number) ?? 0) + part);
        });
      }
      for (const [number, score] of scores) {
        const doc = this.#docs[number];
        if (doc !== undefined) top.offer(doc.id, score);
      }
      return Promise.resolve(top.results());
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  serialize(): string {
    const terms: [string, number[]][] = [...this.#postings]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([term, postings]) => [
        term,
        postings.docs.flatMap((d, i) => [d, postings.counts[i] ?? 0]),
      ]);
    return JSON.stringify({
      formatVersion: BM25_FORMAT_VERSION,
      type: "bm25",
      k1: this.k1,
      b: this.b,
      stopwords: [...this.stopwords].sort(),
      docs: this.#docs,
      terms,
    });
  }

  /**
   * Rebuilds an index from `serialize()` output, with the k1, b and stopwords it was saved with.
   * @throws RagError INDEX_CORRUPT if the text is not valid JSON, is of another version, has the
   *   wrong shape, or contradicts itself (a chunk's length is not the sum of its term counts)
   */
  static deserialize(text: string): Bm25Index {
    const damaged = (problem: string, cause?: unknown): RagError =>
      new RagError("INDEX_CORRUPT", `The keyword index is damaged: ${problem}`, { cause });

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (error) {
      throw damaged("it is not valid JSON", error);
    }
    // the version first: a newer layout would fail the shape check with a confusing message
    const version = z.object({ formatVersion: z.unknown() }).safeParse(json);
    if (version.success && version.data.formatVersion !== BM25_FORMAT_VERSION) {
      throw damaged(
        `it is format version ${String(version.data.formatVersion)}, this program reads version ${BM25_FORMAT_VERSION.toString()}`,
      );
    }
    const parsed = serializedSchema.safeParse(json);
    if (!parsed.success) throw damaged("it has an unexpected shape", parsed.error);
    const data = parsed.data;

    // saved stopwords are already in index form, and analysing a term again gives the same term
    const index = new Bm25Index({ k1: data.k1, b: data.b, stopwords: data.stopwords });

    const counted = new Array<number>(data.docs.length).fill(0);
    for (const [term, flat] of data.terms) {
      if (flat.length === 0 || flat.length % 2 !== 0) {
        throw damaged(`the entry for "${term}" is not a list of pairs`);
      }
      if (index.#postings.has(term)) throw damaged(`the term "${term}" appears twice`);
      const postings: Postings = { docs: [], counts: [] };
      for (let i = 0; i < flat.length; i += 2) {
        const number = flat[i] as number;
        const count = flat[i + 1] as number;
        if (number >= data.docs.length || count < 1) {
          throw damaged(`the entry for "${term}" points at a chunk that does not exist`);
        }
        postings.docs.push(number);
        postings.counts.push(count);
        counted[number] = (counted[number] ?? 0) + count;
      }
      index.#postings.set(term, postings);
    }

    data.docs.forEach((doc, number) => {
      if (counted[number] !== doc.length) {
        throw damaged(
          `chunk ${doc.id} has length ${doc.length.toString()}, but its terms add up to ${String(counted[number])}`,
        );
      }
      if (index.#numbers.has(doc.id as ChunkId)) throw damaged(`chunk ${doc.id} is listed twice`);
      index.#docs.push({
        id: doc.id as ChunkId,
        length: doc.length,
        metadata: { ...doc.metadata, docId: doc.metadata.docId as DocId },
      });
      index.#numbers.set(doc.id as ChunkId, number);
      index.#totalLength += doc.length;
    });
    return index;
  }
}

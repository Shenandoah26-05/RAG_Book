import type { ParsedDocument } from "../../core/index.js";
import { RagError, makeDocId } from "../../shared/index.js";
import { resolveGold } from "../dataset/resolve-gold.js";
import { goldSchema, questionSchema } from "../dataset/schema.js";
import type { DatasetMeta, Gold, Question } from "../dataset/schema.js";
import { latestPerAnswer } from "./candidates.js";
import type { Candidate } from "./candidates.js";

/** What a good system says to a question the book does not answer, for a promoted refusal. */
export const REFUSAL_REFERENCE = "The book does not cover this.";

/** A candidate that needs a person, and why. The file it goes to is meant to be read and labelled. */
export interface ReviewItem {
  readonly answerId: string;
  readonly question: string;
  readonly rating: "up" | "down";
  readonly note?: string;
  /** What the system answered; empty for a refusal. */
  readonly given: string;
  readonly refusal?: string;
  /** Where the answer said it came from. */
  readonly sources: readonly { readonly page: string; readonly quote: string }[];
  /** Why it was not promoted. */
  readonly reason: string;
}

export interface Skipped {
  readonly answerId: string;
  readonly question: string;
  readonly reason: string;
}

export interface Promotion {
  /** The base dataset followed by `added`: the next version. */
  readonly questions: readonly Question[];
  readonly added: readonly Question[];
  readonly review: readonly ReviewItem[];
  readonly skipped: readonly Skipped[];
}

export interface PromoteInput {
  readonly base: readonly Question[];
  readonly meta: DatasetMeta;
  /** The processed book the labels are checked against. */
  readonly doc: ParsedDocument;
  /** Every line of the candidates file, in file order. */
  readonly candidates: readonly Candidate[];
}

const MAX_ID = 999;

/** Two questions that differ only by case, spacing or a closing "?" are the same question. */
const sameQuestion = (text: string): string =>
  text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[?\s]+$/, "");

const citedNumbers = (answer: string): readonly number[] => [
  ...new Set([...answer.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]))),
];

/** The answer without its `[n]` marks, as a reference answer reads. */
const withoutMarks = (answer: string): string =>
  answer
    .replace(/\s*\[\d+\]/g, "")
    .replace(/\s+/g, " ")
    .trim();

const nextId = (base: readonly Question[]): (() => string) => {
  let last = Math.max(0, ...base.map((q) => Number(q.id.slice(1))));
  return () => {
    last += 1;
    if (last > MAX_ID) {
      throw new RagError("INVALID_ARGUMENT", `Question ids stop at q${MAX_ID.toString()}.`);
    }
    return `q${last.toString().padStart(3, "0")}`;
  };
};

const sourcesOf = (c: Candidate): ReviewItem["sources"] =>
  c.citations.map((s) => ({
    page:
      s.pageStart === s.pageEnd
        ? s.pageStart.toString()
        : `${s.pageStart.toString()}-${s.pageEnd.toString()}`,
    quote: s.quote,
  }));

/**
 * Turns the rated answers into the next version of the evaluation dataset.
 *
 * What a rating can say about a question:
 * - **Up, answered**: the answer was right and its sources were the ones. The question is kept with
 *   the answer as reference and each cited passage as a gold quote (it must be found once on its
 *   page, as in any dataset).
 * - **Up, declined**: the book was right not to answer. Kept as an unanswerable question.
 * - **Down**: the reader says it was wrong, not what is right. Nothing can be labelled from that, so
 *   it goes to the review list for a person to answer and label.
 * - Anything else that cannot be promoted safely (another book, a question already in the dataset,
 *   an answer with no source) is skipped, and the reason is given.
 *
 * Ids continue after the highest in the base and are never reused. The base is not changed.
 *
 * @throws RagError INVALID_ARGUMENT if the ids run out
 */
export function promoteCandidates(input: PromoteInput): Promotion {
  const { base, meta, doc, candidates } = input;
  const book = makeDocId(meta.source.sha256);
  const newId = nextId(base);
  const known = new Set(base.map((q) => sameQuestion(q.question)));

  const added: Question[] = [];
  const review: ReviewItem[] = [];
  const skipped: Skipped[] = [];

  for (const c of latestPerAnswer(candidates)) {
    const skip = (reason: string): void => {
      skipped.push({ answerId: c.answerId, question: c.question, reason });
    };
    const toReview = (reason: string): void => {
      review.push({
        answerId: c.answerId,
        question: c.question,
        rating: c.rating,
        ...(c.note === undefined || c.note === "" ? {} : { note: c.note }),
        given: c.answer,
        ...(c.refusal === undefined ? {} : { refusal: c.refusal }),
        sources: sourcesOf(c),
        reason,
      });
    };

    const docId = c.docId ?? c.citations[0]?.docId;
    if (docId === undefined) {
      skip("it does not say which book it was asked of");
      continue;
    }
    if (docId !== book) {
      skip("it was asked of another book than this dataset's");
      continue;
    }
    const key = sameQuestion(c.question);
    if (known.has(key)) {
      skip("the question is already in the dataset");
      continue;
    }

    if (c.rating === "down") {
      known.add(key);
      toReview("rated down: the right answer and where it is must be written by a person");
      continue;
    }

    // ---- rated up ----
    if (c.refusal !== undefined && c.answer.trim() === "" && c.citations.length === 0) {
      const question = questionSchema.safeParse({
        id: "q000",
        question: c.question.trim(),
        kind: "unanswerable",
        answer: REFUSAL_REFERENCE,
        gold: [],
      });
      if (!question.success) {
        skip(`the question is not usable: ${question.error.issues[0]?.message ?? "invalid"}`);
        continue;
      }
      known.add(key);
      added.push({ ...question.data, id: newId() });
      continue;
    }

    const answer = withoutMarks(c.answer);
    if (answer === "") {
      skip("there is no answer to keep");
      continue;
    }
    const sources = citedNumbers(c.answer).flatMap((n) => c.citations.filter((s) => s.index === n));
    if (sources.length === 0) {
      skip("the answer cites no source, so there is nothing to label");
      continue;
    }

    const gold: Gold[] = [];
    for (const s of sources) {
      // a passage that runs over two pages has no single page to be found on
      if (s.pageStart !== s.pageEnd) continue;
      const candidateGold = goldSchema.safeParse({ page: s.pageStart, quote: s.quote.trim() });
      if (!candidateGold.success) continue;
      if (resolveGold(doc, candidateGold.data).ok) gold.push(candidateGold.data);
    }
    if (gold.length === 0) {
      known.add(key);
      toReview("rated up, but no cited passage could be found once on a single page");
      continue;
    }

    const pages = new Set(gold.map((g) => g.page));
    const question = questionSchema.safeParse({
      id: "q000",
      question: c.question.trim(),
      kind: pages.size > 1 ? "multi-part" : "factual",
      answer,
      gold,
    });
    if (!question.success) {
      skip(`the question is not usable: ${question.error.issues[0]?.message ?? "invalid"}`);
      continue;
    }
    known.add(key);
    added.push({ ...question.data, id: newId() });
  }

  return { questions: [...base, ...added], added, review, skipped };
}

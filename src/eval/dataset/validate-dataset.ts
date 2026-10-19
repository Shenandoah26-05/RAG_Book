import type { ParsedDocument } from "../../core/index.js";
import { resolveGold } from "./resolve-gold.js";
import { QUESTION_KINDS } from "./schema.js";
import type { DatasetMeta, Question } from "./schema.js";

/** The least a dataset must hold (RAG-080). */
export const MIN_QUESTIONS = 40;
export const MIN_UNANSWERABLE = 5;

export type DatasetViolationCode =
  | "too-few-questions"
  | "too-few-unanswerable"
  | "missing-kind"
  | "duplicate-id"
  | "duplicate-question"
  | "wrong-document"
  | "page-out-of-range"
  | "page-missing"
  | "quote-not-found"
  | "quote-ambiguous";

export interface DatasetViolation {
  readonly code: DatasetViolationCode;
  /** The question concerned, when the problem is about one. */
  readonly id?: string;
  readonly message: string;
}

/** One line per violation, for a failure message. */
export function formatDatasetViolations(violations: readonly DatasetViolation[]): string {
  return violations
    .map((v) => `${v.code}${v.id === undefined ? "" : ` (${v.id})`}: ${v.message}`)
    .join("\n");
}

/** Counts of each kind, for reports. */
export function countByKind(questions: readonly Question[]): Record<Question["kind"], number> {
  const counts = { factual: 0, "multi-part": 0, unanswerable: 0 };
  for (const q of questions) counts[q.kind] += 1;
  return counts;
}

/**
 * Checks the dataset as a whole, without the book: enough questions, every kind present, enough
 * unanswerable ones, no repeated ids or questions, and no gold page beyond the book's length.
 */
export function checkDatasetShape(
  questions: readonly Question[],
  meta: DatasetMeta,
): readonly DatasetViolation[] {
  const violations: DatasetViolation[] = [];
  const add = (v: DatasetViolation): void => {
    violations.push(v);
  };

  if (questions.length < MIN_QUESTIONS) {
    add({
      code: "too-few-questions",
      message: `${questions.length.toString()} questions, at least ${MIN_QUESTIONS.toString()} are needed`,
    });
  }
  const counts = countByKind(questions);
  for (const kind of QUESTION_KINDS) {
    if (counts[kind] === 0) add({ code: "missing-kind", message: `no ${kind} question` });
  }
  if (counts.unanswerable < MIN_UNANSWERABLE) {
    add({
      code: "too-few-unanswerable",
      message: `${counts.unanswerable.toString()} unanswerable questions, at least ${MIN_UNANSWERABLE.toString()} are needed`,
    });
  }

  const ids = new Set<string>();
  const texts = new Set<string>();
  for (const q of questions) {
    if (ids.has(q.id)) add({ code: "duplicate-id", id: q.id, message: "id used twice" });
    ids.add(q.id);
    const text = q.question.trim().toLowerCase();
    if (texts.has(text)) {
      add({ code: "duplicate-question", id: q.id, message: "same question asked twice" });
    }
    texts.add(text);
    for (const g of q.gold) {
      if (g.page > meta.source.pageCount) {
        add({
          code: "page-out-of-range",
          id: q.id,
          message: `gold page ${g.page.toString()} is beyond the ${meta.source.pageCount.toString()} pages of the book`,
        });
      }
    }
  }
  return violations;
}

/**
 * Checks every gold quote against the processed book: the page exists, the words are on it, and
 * they appear once. Also checks the book is the one the labels were written for.
 */
export function checkDatasetAgainstDocument(
  questions: readonly Question[],
  meta: DatasetMeta,
  doc: ParsedDocument,
): readonly DatasetViolation[] {
  if (doc.sha256 !== meta.source.sha256) {
    return [
      {
        code: "wrong-document",
        message: `the labels were written for a file with SHA-256 ${meta.source.sha256}, but this document has ${doc.sha256}`,
      },
    ];
  }
  const violations: DatasetViolation[] = [];
  for (const q of questions) {
    for (const gold of q.gold) {
      const resolved = resolveGold(doc, gold);
      if (!resolved.ok)
        violations.push({ code: resolved.code, id: q.id, message: resolved.message });
    }
  }
  return violations;
}

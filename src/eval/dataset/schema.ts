import { z } from "zod";

/** What a question tests. */
export const QUESTION_KINDS = ["factual", "multi-part", "unanswerable"] as const;
export type QuestionKind = (typeof QUESTION_KINDS)[number];

/**
 * Where the answer is, written the way a person finds it: a page and the words on it. The words
 * are matched against the processed document to get character offsets (see `resolveGold`), so a
 * label never has to be updated when the chunker changes.
 */
export const goldSchema = z.strictObject({
  /** 1-based page number, as in the PDF viewer. */
  page: z.number().int().positive(),
  /** Words copied from that page. Line breaks and runs of spaces may differ from the page. */
  quote: z.string().min(12, "a quote must be at least 12 characters, or it will match anywhere"),
});
export type Gold = z.infer<typeof goldSchema>;

export const questionSchema = z
  .strictObject({
    id: z.string().regex(/^q\d{3}$/, 'must look like "q007"'),
    question: z.string().min(10),
    kind: z.enum(QUESTION_KINDS),
    /** The reference answer. For an unanswerable question, what a good system says instead. */
    answer: z.string().min(1),
    /** Passages that hold the answer. Empty exactly when the question is unanswerable. */
    gold: z.array(goldSchema),
  })
  .superRefine((q, ctx) => {
    if (q.kind === "unanswerable" && q.gold.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["gold"],
        message: "an unanswerable question has no gold",
      });
    }
    if (q.kind !== "unanswerable" && q.gold.length === 0) {
      ctx.addIssue({ code: "custom", path: ["gold"], message: "needs at least one gold passage" });
    }
  });
export type Question = z.infer<typeof questionSchema>;

/** Describes the source the labels were written against, so a different book is noticed. */
export const datasetMetaSchema = z.strictObject({
  version: z.string().min(1),
  source: z.strictObject({
    title: z.string().min(1),
    /** SHA-256 (hex) of the PDF. */
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    pageCount: z.number().int().positive(),
  }),
});
export type DatasetMeta = z.infer<typeof datasetMetaSchema>;

import { z } from "zod";

// The file `evals/candidates.jsonl`: one line per rating a reader gave, added by the API
// (`JsonlFeedbackStore`). This is the reading side of it. The two meet only in the file, which is
// why this schema is checked against what the store writes in a test of its own
// (src/composition/feedback-file.test.ts).

const citationSchema = z.looseObject({
  index: z.number().int().min(1),
  docId: z.string(),
  pageStart: z.number().int().min(1),
  pageEnd: z.number().int().min(1),
  quote: z.string(),
});

export const candidateSchema = z.looseObject({
  answerId: z.string().min(1),
  savedAt: z.string(),
  rating: z.enum(["up", "down"]),
  note: z.string().optional(),
  question: z.string(),
  answer: z.string(),
  refusal: z.string().optional(),
  docId: z.string().optional(),
  citations: z.array(citationSchema),
  system: z.looseObject({ index: z.string(), model: z.string() }),
});
export type Candidate = z.infer<typeof candidateSchema>;

/** A line that could not be used, and why. */
export interface MalformedLine {
  /** 1-based. */
  readonly line: number;
  readonly message: string;
}

/**
 * Reads the candidates file. A line that is not a candidate is reported and skipped, not fatal: the
 * file is added to while the API runs, and a crash can leave the last line half written. The
 * reader's other ratings must not be lost to it.
 */
export function parseCandidates(jsonl: string): {
  readonly candidates: readonly Candidate[];
  readonly malformed: readonly MalformedLine[];
} {
  const candidates: Candidate[] = [];
  const malformed: MalformedLine[] = [];
  jsonl.split(/\r?\n/).forEach((text, index) => {
    if (text.trim() === "") return;
    const line = index + 1;
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      malformed.push({ line, message: "not valid JSON" });
      return;
    }
    const parsed = candidateSchema.safeParse(json);
    if (parsed.success) candidates.push(parsed.data);
    else {
      const problems = parsed.error.issues
        .map((i) => `${i.path.join(".") || "(entry)"}: ${i.message}`)
        .join("; ");
      malformed.push({ line, message: problems });
    }
  });
  return { candidates, malformed };
}

/**
 * The reader's final word on each answer: for an `answerId` rated more than once (the rating
 * changed, or a note was added), the last entry in the file. Order of last appearance is kept.
 */
export function latestPerAnswer(candidates: readonly Candidate[]): readonly Candidate[] {
  const latest = new Map<string, Candidate>();
  for (const candidate of candidates) {
    // delete first so a re-rated answer moves to where its last rating is
    latest.delete(candidate.answerId);
    latest.set(candidate.answerId, candidate);
  }
  return [...latest.values()];
}

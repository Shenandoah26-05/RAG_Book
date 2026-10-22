import { z } from "zod";
import type { ExperimentSummary, QuestionResult } from "../../core/index.js";
import { RagError } from "../../shared/index.js";

// What a finished experiment run looks like on disk, and a check that a file really has that shape.
// The files are written by `FileExperimentStore` (RAG-083) and may be old, edited or cut short, so
// everything read back is checked here instead of trusted. Keep these schemas in step with
// core/types/experiment.ts.

const score = z.number().min(0).max(1);
const count = z.number().int().nonnegative();
const ms = z.number().nonnegative();

const models = z.object({
  embedder: z.string(),
  generator: z.string(),
  judge: z.string().optional(),
});

const retrievalScores = z.object({
  hit: score,
  precision: score,
  recall: score,
  mrr: score,
  ndcg: score,
});

const questionResult = z.object({
  experiment: z.string(),
  variant: z.string(),
  configHash: z.string(),
  gitCommit: z.string().nullable(),
  datasetVersion: z.string(),
  models,
  questionId: z.string(),
  kind: z.enum(["factual", "multi-part", "unanswerable"]),
  k: z.number().int().positive(),
  retrieved: z.array(
    z.object({
      chunkId: z.string(),
      rank: z.number().int().positive(),
      score: z.number(),
      pageStart: z.number().int(),
      pageEnd: z.number().int(),
      relevant: z.boolean(),
    }),
  ),
  retrieval: retrievalScores.optional(),
  answered: z.boolean(),
  refusal: z.string().optional(),
  answer: z.string().optional(),
  generation: z
    .object({
      faithfulness: score.optional(),
      relevance: score,
      correctness: score,
      promptVersions: z.array(z.string()),
    })
    .optional(),
  latencyMs: z.object({ retrieval: ms, generation: ms.optional(), judge: ms.optional() }),
  tokens: z.object({ prompt: count.optional(), output: count.optional() }).optional(),
  error: z.string().optional(),
});

const variantSummary = z.object({
  variant: z.string(),
  configHash: z.string(),
  settings: z.record(z.string(), z.unknown()),
  configFile: z.string(),
  k: count,
  models,
  index: z.object({ namespace: z.string(), status: z.enum(["built", "reused"]) }),
  questions: z.object({
    total: count,
    answerable: count,
    unanswerable: count,
    failed: count,
  }),
  retrieval: retrievalScores.extend({ questions: count }).optional(),
  generation: z
    .object({
      judged: count,
      faithfulness: score.optional(),
      relevance: score,
      correctness: score,
    })
    .optional(),
  refusals: z.object({ unanswerableRefused: count, answerableRefused: count }),
  latencyMs: z.object({
    retrievalP50: ms,
    retrievalP95: ms,
    generationP50: ms.optional(),
    generationP95: ms.optional(),
  }),
  tokens: z.object({ prompt: count, output: count }),
  error: z.string().optional(),
});

const experimentSummary = z.object({
  experiment: z.string(),
  description: z.string().optional(),
  dataset: z.string(),
  datasetVersion: z.string(),
  gitCommit: z.string().nullable(),
  startedAt: z.string(),
  finishedAt: z.string(),
  generation: z.boolean(),
  variants: z.array(variantSummary),
});

const describe = (error: z.ZodError): string =>
  error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`)
    .join("; ");

/**
 * Reads `results.jsonl`. A run that was stopped half-way is fine (every finished line is kept), but
 * a line that is not a valid result is an error with its line number: a report built on a damaged
 * file would quietly leave results out.
 *
 * @throws RagError INVALID_ARGUMENT for a line that is not JSON or not a result
 */
export function parseResults(text: string): QuestionResult[] {
  const results: QuestionResult[] = [];
  text.split("\n").forEach((line, index) => {
    if (line.trim() === "") return;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      throw new RagError(
        "INVALID_ARGUMENT",
        `results.jsonl line ${(index + 1).toString()} is not JSON`,
      );
    }
    const parsed = questionResult.safeParse(json);
    if (!parsed.success) {
      throw new RagError(
        "INVALID_ARGUMENT",
        `results.jsonl line ${(index + 1).toString()} is not a result: ${describe(parsed.error)}`,
      );
    }
    results.push(parsed.data);
  });
  return results;
}

/**
 * Reads `summary.json`.
 * @throws RagError INVALID_ARGUMENT if it is not JSON or not an experiment summary
 */
export function parseSummary(text: string): ExperimentSummary {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new RagError("INVALID_ARGUMENT", "summary.json is not JSON");
  }
  const parsed = experimentSummary.safeParse(json);
  if (!parsed.success) {
    throw new RagError(
      "INVALID_ARGUMENT",
      `summary.json is not an experiment summary: ${describe(parsed.error)}`,
    );
  }
  return parsed.data;
}

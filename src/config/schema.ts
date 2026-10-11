import { z } from "zod";

/** Strategy, provider and model-kind names in config are kebab-case strings, e.g. "parent-child". */
const name = z
  .string("must be a string")
  .regex(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/, 'must be a kebab-case name, e.g. "my-strategy"');

const text = z.string("must be a string").min(1, "must not be empty");
const positiveInt = z
  .number("must be a number")
  .int("must be a whole number")
  .positive("must be greater than 0");
const flag = z.boolean("must be true or false");

/**
 * Every section of rag.config.json. Objects are strict: an unknown key is an error, so a typo such
 * as "chunking.maxToken" fails at startup instead of being silently ignored.
 *
 * Names are not closed enums on purpose. Adding a strategy means one new class and one registry
 * line in composition/; the registry rejects names it does not know.
 */
export const ragConfigSchema = z
  .strictObject({
    ingestion: z.strictObject({
      loader: name,
      cleaners: z.array(name, "must be a list of names"),
    }),
    chunking: z
      .strictObject({
        strategy: name,
        tokenizer: name,
        maxTokens: positiveInt,
        overlapTokens: z
          .number("must be a number")
          .int("must be a whole number")
          .nonnegative("must be 0 or greater"),
      })
      .refine((c) => c.overlapTokens < c.maxTokens, {
        path: ["overlapTokens"],
        error: "must be smaller than maxTokens",
      }),
    embedding: z.strictObject({
      provider: name,
      model: text,
      batchSize: positiveInt,
    }),
    vectorStore: z.strictObject({
      type: name,
      dir: text,
    }),
    retrieval: z.strictObject({
      strategy: name,
      k: positiveInt,
      fusion: name,
    }),
    rerank: z.strictObject({
      enabled: flag,
      strategy: name,
      candidates: positiveInt,
    }),
    generation: z.strictObject({
      provider: name,
      model: text,
      contextBudgetTokens: positiveInt,
      ordering: name,
    }),
  })
  .refine((c) => !c.rerank.enabled || c.rerank.candidates >= c.retrieval.k, {
    path: ["rerank", "candidates"],
    error: "must be at least retrieval.k when reranking is enabled",
  });

type DeepReadonly<T> = T extends readonly (infer U)[]
  ? readonly DeepReadonly<U>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

/** The validated configuration. Read it once in the composition root and pass values down. */
export type RagConfig = DeepReadonly<z.infer<typeof ragConfigSchema>>;

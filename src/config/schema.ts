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
const price = z.number("must be a number").nonnegative("must be 0 or greater");
const wholeNumber = z
  .number("must be a number")
  .int("must be a whole number")
  .nonnegative("must be 0 or greater");

/**
 * How a model or an embedder is protected from the network (RAG-092). Every number is "off" at 0, so
 * a setting is never needed to turn something off. The decorators are built from these in
 * composition/, not in the adapters.
 */
const resilience = z
  .strictObject({
    /** Tries again after a failure that may pass (a dropped connection, a timeout, HTTP 429 or 5xx). */
    retries: wholeNumber,
    /** Wait before the first retry; it doubles each time, with jitter. */
    backoffMs: wholeNumber,
    /** No retry waits longer than this, and a server asking for more is not waited for. */
    maxBackoffMs: wholeNumber,
    /** Gives up when nothing has arrived for this long (a reply), or the call has taken this long (an embedding). */
    timeoutMs: wholeNumber,
    /** At most this many calls start in any minute. */
    requestsPerMinute: wholeNumber,
    /** At most this many calls run at once. */
    maxConcurrent: wholeNumber,
  })
  .refine((r) => r.maxBackoffMs >= r.backoffMs, {
    path: ["maxBackoffMs"],
    error: "must be at least backoffMs",
  });

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
      concurrency: positiveInt,
    }),
    /**
     * What the models cost (RAG-093), by model id as it appears in a trace, e.g.
     * "openai-compatible:gpt-4o-mini". A model that is not listed has no price: its calls are counted
     * in tokens and shown as unpriced. A local model can be listed at 0 to say it is free.
     */
    pricing: z.strictObject({
      currency: text,
      models: z.record(text, z.strictObject({ inputPerMillion: price, outputPerMillion: price })),
    }),
    resilience: z.strictObject({ generation: resilience, embedding: resilience }),
    queryTransform: z.strictObject({
      rewrite: flag,
      historyTurns: positiveInt,
      hyde: flag,
      multiQuery: flag,
      multiQueryCount: positiveInt,
    }),
    generation: z.strictObject({
      provider: name,
      model: text,
      temperature: z
        .number("must be a number")
        .min(0, "must be 0 or greater")
        .max(2, "must be 2 or less"),
      maxOutputTokens: positiveInt,
      contextBudgetTokens: positiveInt,
      ordering: name,
    }),
    // The model that scores answers (RAG-082). Its own section so it can differ from the generator:
    // a model grading its own answers is lenient with them.
    judge: z.strictObject({
      provider: name,
      model: text,
      maxOutputTokens: positiveInt,
    }),
    grounding: z.strictObject({
      // 0 never refuses on score; scores are on the scale of the retriever (or reranker) in use
      minScore: z.number("must be a number").min(0, "must be 0 or greater"),
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

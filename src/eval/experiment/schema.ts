import { z } from "zod";

/** A name that is safe in a file name and readable in a table: `bm25`, `chunking.strategy=fixed+k=5`. */
export const VARIANT_NAME = /^[A-Za-z0-9][A-Za-z0-9._=+-]*$/;

/** A dotted path into the config: `retrieval.k`, `chunking.maxTokens`. */
export const SETTING_PATH = /^[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*)+$/;

const settingValue = z.union([z.string(), z.number(), z.boolean()]);

/**
 * A variant is a partial configuration: the same shape as `rag.config.json`, listing only what
 * differs. The runner does not know what any key means; the config loader checks them.
 */
export const variantSchema = z.strictObject({
  name: z.string().regex(VARIANT_NAME, "use letters, digits and . _ = + -"),
  config: z.record(z.string(), z.unknown()),
});
export type VariantSpec = z.infer<typeof variantSchema>;

/**
 * An experiment file (`evals/experiments/*.json`). Variants come from `variants` (written out) and
 * from `matrix` (every combination of the listed values), on top of `base`.
 *
 *   { "name": "retrievers", "base": { "chunking": { "strategy": "recursive" } },
 *     "matrix": { "retrieval.strategy": ["dense", "bm25", "hybrid"], "retrieval.k": [3, 5] } }
 *
 * makes six variants. Precedence, lowest first: `base`, `matrix`, a variant's own `config`.
 */
export const experimentSchema = z
  .strictObject({
    name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "use lower-case letters, digits and -"),
    description: z.string().optional(),
    /** The dataset, as a path to its `.jsonl` file. Its `.meta.json` sits beside it. */
    dataset: z.string().min(1).default("evals/datasets/v1.jsonl"),
    /**
     * Whether to generate answers and judge them. Off by default: retrieval metrics need no
     * model for the answer, and generating and judging every question of every variant is slow.
     */
    generation: z.boolean().default(false),
    base: z.record(z.string(), z.unknown()).default({}),
    matrix: z.record(z.string().regex(SETTING_PATH), z.array(settingValue).min(1)).default({}),
    variants: z.array(variantSchema).default([]),
  })
  .refine((e) => e.variants.length > 0 || Object.keys(e.matrix).length > 0, {
    path: ["variants"],
    error: "an experiment needs at least one variant: list some in `variants` or give a `matrix`",
  });
export type Experiment = z.infer<typeof experimentSchema>;

import { z } from "zod";
import { RagError } from "../../shared/index.js";

/**
 * What the code must know about one embedding model that the model's name does not tell it: how
 * long its vectors are, and which marker it expects in front of a question and in front of a
 * passage (empty when it expects none).
 */
const profileSchema = z.strictObject({
  dimensions: z.number().int().positive(),
  queryPrefix: z.string().default(""),
  documentPrefix: z.string().default(""),
});

/** The model-profile file: model name (as Ollama knows it) to its profile. */
const profilesSchema = z.record(z.string().min(1), profileSchema);

export type EmbeddingModelProfile = z.infer<typeof profileSchema>;
export type EmbeddingProfiles = ReadonlyMap<string, EmbeddingModelProfile>;

/**
 * Checks the contents of a model-profile file and returns the profiles by model name.
 * @throws RagError CONFIG_INVALID naming the file and the first problem
 */
export function parseEmbeddingProfiles(json: unknown, source: string): EmbeddingProfiles {
  const parsed = profilesSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue === undefined ? "" : ` at ${issue.path.join(".")}: ${issue.message}`;
    throw new RagError("CONFIG_INVALID", `Invalid embedding model profiles in ${source}${where}`, {
      cause: parsed.error,
    });
  }
  return new Map(Object.entries(parsed.data));
}

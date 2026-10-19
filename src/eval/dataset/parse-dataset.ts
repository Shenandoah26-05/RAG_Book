import { RagError } from "../../shared/index.js";
import { questionSchema } from "./schema.js";
import type { Question } from "./schema.js";

/**
 * Reads a JSON Lines dataset: one question per line, blank lines ignored.
 * @throws RagError INVALID_ARGUMENT naming the line of the first mistake
 */
export function parseDataset(jsonl: string): readonly Question[] {
  const questions: Question[] = [];
  jsonl.split(/\r?\n/).forEach((line, index) => {
    if (line.trim() === "") return;
    const where = `line ${(index + 1).toString()}`;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch (cause) {
      throw new RagError("INVALID_ARGUMENT", `Dataset ${where} is not valid JSON`, { cause });
    }
    const parsed = questionSchema.safeParse(json);
    if (!parsed.success) {
      const problems = parsed.error.issues
        .map((i) => `${i.path.join(".") || "(question)"}: ${i.message}`)
        .join("; ");
      throw new RagError(
        "INVALID_ARGUMENT",
        `Dataset ${where} is not a valid question: ${problems}`,
      );
    }
    questions.push(parsed.data);
  });
  return questions;
}

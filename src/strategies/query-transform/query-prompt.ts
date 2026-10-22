import type { PromptTemplate } from "../../core/index.js";
import { RagError } from "../../shared/index.js";

const FILE_NAME = /^(?<id>[a-z][a-z0-9-]*)\.(?<version>v\d+)\.txt$/;
const PLACEHOLDER = /\{\{(\w+)\}\}/g;

const countOf = (text: string, placeholder: string): number => text.split(placeholder).length - 1;

/**
 * Builds a prompt for a query transformer from a file in `prompts/`, the way `parsePromptTemplate`
 * does for the answer prompt: the name carries the id and the version (`rewrite-question.v1.txt`).
 * Reading the file is the composition root's job; this only checks what it read.
 *
 * @param placeholders the names that must each appear exactly once, e.g. `["question", "history"]`
 * @throws RagError INVALID_ARGUMENT if the name does not look like `<id>.v<N>.txt` or a placeholder
 * is missing or repeated
 */
export function parseQueryPrompt(
  fileName: string,
  text: string,
  placeholders: readonly string[],
): PromptTemplate {
  const match = FILE_NAME.exec(fileName);
  if (!match?.groups) {
    throw new RagError(
      "INVALID_ARGUMENT",
      `Prompt file "${fileName}" must be named <id>.v<N>.txt, e.g. rewrite-question.v1.txt`,
    );
  }
  for (const name of placeholders) {
    const found = countOf(text, `{{${name}}}`);
    if (found !== 1) {
      throw new RagError(
        "INVALID_ARGUMENT",
        `Prompt ${fileName} must contain {{${name}}} exactly once, found ${found.toString()}`,
      );
    }
  }
  return { id: match.groups.id as string, version: match.groups.version as string, text };
}

/**
 * The prompt with its placeholders filled. It is one pass over the template, so a value that
 * happens to contain `{{question}}` (a book can) is not substituted a second time.
 */
export function fillQueryPrompt(
  template: PromptTemplate,
  values: Readonly<Record<string, string>>,
): string {
  return template.text.replace(PLACEHOLDER, (whole, name: string) => values[name] ?? whole);
}

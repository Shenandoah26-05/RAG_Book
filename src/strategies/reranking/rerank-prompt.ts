import type { PromptTemplate } from "../../core/index.js";
import { RagError } from "../../shared/index.js";

export const QUESTION_PLACEHOLDER = "{{question}}";
export const PASSAGE_PLACEHOLDER = "{{passage}}";

const FILE_NAME = /^(?<id>[a-z][a-z0-9-]*)\.(?<version>v\d+)\.txt$/;
const PLACEHOLDER = /\{\{(question|passage)\}\}/g;

const countOf = (text: string, placeholder: string): number => text.split(placeholder).length - 1;

/**
 * Builds the relevance prompt from a file in `prompts/`, like `parsePromptTemplate` does for the
 * answer prompt: the name carries the id and the version (`rerank-relevance.v1.txt`). Reading the
 * file is the composition root's job; this only checks what it read.
 *
 * @throws RagError INVALID_ARGUMENT if the name does not look like `<id>.v<N>.txt` or the text does
 * not contain `{{question}}` and `{{passage}}` exactly once each
 */
export function parseRerankPrompt(fileName: string, text: string): PromptTemplate {
  const match = FILE_NAME.exec(fileName);
  if (!match?.groups) {
    throw new RagError(
      "INVALID_ARGUMENT",
      `Prompt file "${fileName}" must be named <id>.v<N>.txt, e.g. rerank-relevance.v1.txt`,
    );
  }
  // a prompt reads the same on every system: a checkout with Windows line endings changes nothing
  const normalised = text.replaceAll("\r\n", "\n");
  for (const placeholder of [QUESTION_PLACEHOLDER, PASSAGE_PLACEHOLDER]) {
    const found = countOf(normalised, placeholder);
    if (found !== 1) {
      throw new RagError(
        "INVALID_ARGUMENT",
        `Prompt ${fileName} must contain ${placeholder} exactly once, found ${found.toString()}`,
      );
    }
  }
  return {
    id: match.groups.id as string,
    version: match.groups.version as string,
    text: normalised,
  };
}

/**
 * The prompt for one question and one passage. Both are filled in a single pass over the template,
 * so a passage that happens to contain the text `{{question}}` is not substituted a second time.
 */
export function fillRerankPrompt(
  template: PromptTemplate,
  question: string,
  passage: string,
): string {
  return template.text.replace(PLACEHOLDER, (_, name: string) =>
    name === "question" ? question.trim() : passage.trim(),
  );
}

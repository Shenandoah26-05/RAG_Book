import type { PromptTemplate } from "../../core/index.js";
import { RagError } from "../../shared/index.js";

export const SOURCES_PLACEHOLDER = "{{sources}}";

const FILE_NAME = /^(?<id>[a-z][a-z0-9-]*)\.(?<version>v\d+)\.txt$/;

/**
 * Builds a template from a file in `prompts/`. The name carries the id and the version
 * (`rag-system.v1.txt`), so the version cannot disagree with the file it came from. Reading the file
 * is the composition root's job; this only checks what it read.
 *
 * @throws RagError INVALID_ARGUMENT if the name does not look like `<id>.v<N>.txt` or the text does
 * not contain `{{sources}}` exactly once
 */
export function parsePromptTemplate(fileName: string, text: string): PromptTemplate {
  const match = FILE_NAME.exec(fileName);
  if (!match?.groups) {
    throw new RagError(
      "INVALID_ARGUMENT",
      `Prompt file "${fileName}" must be named <id>.v<N>.txt, e.g. rag-system.v1.txt`,
    );
  }
  const placeholders = text.split(SOURCES_PLACEHOLDER).length - 1;
  if (placeholders !== 1) {
    throw new RagError(
      "INVALID_ARGUMENT",
      `Prompt ${fileName} must contain ${SOURCES_PLACEHOLDER} exactly once, found ${placeholders.toString()}`,
    );
  }
  return { id: match.groups.id as string, version: match.groups.version as string, text };
}

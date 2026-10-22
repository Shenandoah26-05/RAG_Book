import type { PromptTemplate } from "../../core/index.js";
import { RagError } from "../../shared/index.js";

/** The three things the judge measures; each has its own prompt file. */
export type JudgeMetric = "faithfulness" | "relevance" | "correctness";

export type JudgePlaceholder = "sources" | "question" | "answer" | "reference";

/** What each prompt must contain, once each. */
export const JUDGE_PLACEHOLDERS: Readonly<Record<JudgeMetric, readonly JudgePlaceholder[]>> = {
  faithfulness: ["sources", "answer"],
  relevance: ["question", "answer"],
  correctness: ["question", "reference", "answer"],
};

/** The file each metric's prompt is read from. The name carries the version. */
export const JUDGE_PROMPT_FILES: Readonly<Record<JudgeMetric, string>> = {
  faithfulness: "judge-faithfulness.v1.txt",
  relevance: "judge-relevance.v1.txt",
  correctness: "judge-correctness.v1.txt",
};

const FILE_NAME = /^(?<id>[a-z][a-z0-9-]*)\.(?<version>v\d+)\.txt$/;
const PLACEHOLDER = /\{\{(\w+)\}\}/g;

const countOf = (text: string, placeholder: string): number => text.split(placeholder).length - 1;

/**
 * Builds a judge prompt from a file in `prompts/`, like `parsePromptTemplate` does for the answer
 * prompt. Reading the file is the composition root's job; this only checks what it read.
 *
 * @throws RagError INVALID_ARGUMENT if the name is not `<id>.v<N>.txt`, or the text does not hold
 * each placeholder of `metric` exactly once, or holds one that does not belong to it
 */
export function parseJudgePrompt(
  metric: JudgeMetric,
  fileName: string,
  text: string,
): PromptTemplate {
  const match = FILE_NAME.exec(fileName);
  if (!match?.groups) {
    throw new RagError(
      "INVALID_ARGUMENT",
      `Prompt file "${fileName}" must be named <id>.v<N>.txt, e.g. ${JUDGE_PROMPT_FILES[metric]}`,
    );
  }
  const normalised = text.replaceAll("\r\n", "\n");
  const allowed: readonly string[] = JUDGE_PLACEHOLDERS[metric];
  for (const name of allowed) {
    const found = countOf(normalised, `{{${name}}}`);
    if (found !== 1) {
      throw new RagError(
        "INVALID_ARGUMENT",
        `Prompt ${fileName} must contain {{${name}}} exactly once, found ${found.toString()}`,
      );
    }
  }
  for (const [, name] of normalised.matchAll(PLACEHOLDER)) {
    if (name !== undefined && !allowed.includes(name)) {
      throw new RagError(
        "INVALID_ARGUMENT",
        `Prompt ${fileName} has {{${name}}}, which the ${metric} judge does not fill in`,
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
 * Fills every placeholder in one pass over the template, so a source or an answer that happens to
 * contain `{{answer}}` is not substituted a second time.
 */
export function fillJudgePrompt(
  template: PromptTemplate,
  values: Readonly<Partial<Record<JudgePlaceholder, string>>>,
): string {
  return template.text.replace(
    PLACEHOLDER,
    (whole, name: string) => values[name as JudgePlaceholder]?.trim() ?? whole,
  );
}

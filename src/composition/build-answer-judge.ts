import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RagConfig } from "../config/index.js";
import type { AnswerJudge, LlmProvider } from "../core/index.js";
import { JUDGE_PROMPT_FILES, LlmAnswerJudge, parseJudgePrompt } from "../eval/index.js";
import type { JudgeMetric } from "../eval/index.js";
import { noopLogger, RagError } from "../shared/index.js";
import type { Logger } from "../shared/index.js";
import { buildLlmProvider } from "./build-llm-provider.js";

/** `prompts/` at the root of the project, whether this runs from `src/` or from the build. */
const DEFAULT_PROMPTS_DIR = fileURLToPath(new URL("../../prompts/", import.meta.url));

const METRICS = [
  "faithfulness",
  "relevance",
  "correctness",
] as const satisfies readonly JudgeMetric[];

export interface BuildAnswerJudgeOptions {
  /** The model that judges. If absent it is built from `judge.*`. */
  readonly llm?: LlmProvider;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof fetch;
  /** Where the prompt files are. Default: `prompts/` at the project root. */
  readonly promptsDir?: string;
  /** Warns when the judge is the same model as the generator. */
  readonly logger?: Logger;
}

/**
 * Builds the answer judge from `config.judge`, apart from `config.generation`: the judge's provider
 * and model are its own settings, and the generator's temperature and limits are not reused (the
 * judge always asks at temperature 0).
 *
 * @throws RagError CONFIG_INVALID if the provider is unknown or a prompt file cannot be read;
 *   INVALID_ARGUMENT if a prompt file has the wrong placeholders
 */
export function buildAnswerJudge(
  config: Pick<RagConfig, "generation" | "judge">,
  options: BuildAnswerJudgeOptions = {},
): AnswerJudge {
  const { generation, judge } = config;
  const llm =
    options.llm ??
    buildLlmProvider(
      {
        ...generation,
        provider: judge.provider,
        model: judge.model,
        maxOutputTokens: judge.maxOutputTokens,
      },
      {
        ...(options.env === undefined ? {} : { env: options.env }),
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      },
    );
  if (judge.provider === generation.provider && judge.model === generation.model) {
    (options.logger ?? noopLogger).warn(
      "the judge is the same model as the generator, so scores will be too kind; set judge.model to another model",
      { model: judge.model },
    );
  }
  const dir = options.promptsDir ?? DEFAULT_PROMPTS_DIR;
  const prompts = Object.fromEntries(
    METRICS.map((metric) => [metric, loadPrompt(metric, dir)] as const),
  ) as Record<JudgeMetric, ReturnType<typeof parseJudgePrompt>>;
  return new LlmAnswerJudge({ llm, prompts });
}

function loadPrompt(metric: JudgeMetric, dir: string) {
  const fileName = JUDGE_PROMPT_FILES[metric];
  const file = path.join(dir, fileName);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (cause) {
    throw new RagError("CONFIG_INVALID", `Cannot read the ${metric} judge prompt ${file}`, {
      cause,
    });
  }
  return parseJudgePrompt(metric, fileName, text);
}

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CrossEncoderScorer } from "../adapters/index.js";
import type { RagConfig } from "../config/index.js";
import type { LlmProvider, Reranker, Retriever } from "../core/index.js";
import { noopLogger, RagError } from "../shared/index.js";
import type { Logger } from "../shared/index.js";
import {
  LlmReranker,
  NoopReranker,
  parseRerankPrompt,
  RerankingRetriever,
  ScoringReranker,
} from "../strategies/index.js";
import { buildLlmProvider } from "./build-llm-provider.js";
import type { Resilience } from "./build-resilience.js";

type Settings = RagConfig["rerank"];

/** The relevance prompt the LLM reranker uses; the name carries its version. */
export const RERANK_PROMPT_FILE = "rerank-relevance.v1.txt";

/** `prompts/` at the root of the project, whether this runs from `src/` or from the build. */
const DEFAULT_PROMPTS_DIR = fileURLToPath(new URL("../../prompts/", import.meta.url));

/** What a reranker may need from the outside. Everything is optional; the no-op reranker uses none. */
export interface RerankContext {
  /** The model that judges. If absent it is built from `generation`. */
  readonly llm?: LlmProvider;
  /** The `generation.*` settings, whose provider and model the LLM reranker reuses. */
  readonly generation?: RagConfig["generation"];
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof fetch;
  readonly logger?: Logger;
  /** The retries and limits the model built here gets, shared with the answering model. */
  readonly resilience?: Resilience;
  /** Where the prompt files are. Default: `prompts/` at the project root. */
  readonly promptsDir?: string;
}

function llmFor(context: RerankContext): LlmProvider {
  if (context.llm !== undefined) return context.llm;
  if (context.generation === undefined) {
    throw new RagError(
      "CONFIG_INVALID",
      'The "llm" reranker needs a language model: pass the generation settings (or a provider) to build it from.',
    );
  }
  return buildLlmProvider(context.generation, {
    ...(context.env === undefined ? {} : { env: context.env }),
    ...(context.fetch === undefined ? {} : { fetch: context.fetch }),
    ...(context.resilience === undefined ? {} : { resilience: context.resilience }),
  });
}

function loadRerankPrompt(promptsDir: string) {
  const file = path.join(promptsDir, RERANK_PROMPT_FILE);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (cause) {
    throw new RagError("CONFIG_INVALID", `Cannot read the rerank prompt ${file}`, { cause });
  }
  return parseRerankPrompt(RERANK_PROMPT_FILE, text);
}

// The one place that reads `rerank.enabled`. Everything else works with a `Reranker` or a
// `Retriever` and cannot tell whether reranking is on. Adding a reranker is one class and one line
// here.
const RERANKERS: ReadonlyMap<string, (settings: Settings, context: RerankContext) => Reranker> =
  new Map<string, (settings: Settings, context: RerankContext) => Reranker>([
    ["noop", () => new NoopReranker()],
    [
      "llm",
      (settings, context) =>
        new LlmReranker({
          llm: llmFor(context),
          prompt: loadRerankPrompt(context.promptsDir ?? DEFAULT_PROMPTS_DIR),
          concurrency: settings.concurrency,
          logger: context.logger ?? noopLogger,
        }),
    ],
    // the model is not loaded here, only on the first rerank
    ["cross-encoder", () => new ScoringReranker({ scorer: new CrossEncoderScorer() })],
  ]);

/** The names accepted in `rerank.strategy` (when `rerank.enabled` is true). */
export const rerankerNames = (): readonly string[] => [...RERANKERS.keys()];

/** What reranking is set to: the reranker, and how many candidates it should choose from. */
export interface RerankPlan {
  readonly reranker: Reranker;
  /** 0 when reranking is off: nothing extra is fetched. */
  readonly candidates: number;
}

/**
 * Turns `rerank.*` into a reranker. With `rerank.enabled` false the answer is the no-op reranker
 * whatever `rerank.strategy` says (the default config names "llm" while it is off). With it true,
 * `rerank.strategy` must name a known reranker.
 * @throws RagError CONFIG_INVALID if reranking is on and there is no such reranker, or the "llm"
 *   reranker has no model to use or no prompt file
 */
export function resolveRerank(settings: Settings, context: RerankContext = {}): RerankPlan {
  if (!settings.enabled) return { reranker: new NoopReranker(), candidates: 0 };
  const create = RERANKERS.get(settings.strategy);
  if (create === undefined) {
    throw new RagError(
      "CONFIG_INVALID",
      `Unknown reranker "${settings.strategy}" in rerank.strategy. ` +
        `Available rerankers: ${rerankerNames().join(", ")}`,
    );
  }
  return { reranker: create(settings, context), candidates: settings.candidates };
}

/** The reranker `rerank.*` asks for. */
export function buildReranker(settings: Settings, context: RerankContext = {}): Reranker {
  return resolveRerank(settings, context).reranker;
}

/**
 * Wraps `retriever` so it fetches `rerank.candidates` chunks and returns the reranker's best `k`.
 * With reranking off it still wraps, with the no-op reranker, so callers never branch on the flag.
 * @throws RagError CONFIG_INVALID as `resolveRerank` does
 */
export function buildRerankingRetriever(
  retriever: Retriever,
  settings: Settings,
  context: RerankContext = {},
): Retriever {
  return new RerankingRetriever({ retriever, ...resolveRerank(settings, context) });
}

import { readFile } from "node:fs/promises";
import path from "node:path";
import type { RagConfig } from "../config/index.js";
import type { LlmProvider, PromptTemplate, QueryTransformer, Retriever } from "../core/index.js";
import { RagError } from "../shared/index.js";
import {
  FollowUpRewriter,
  HYDE_PLACEHOLDERS,
  HydeTransformer,
  IdentityQueryTransformer,
  MULTI_QUERY_PLACEHOLDERS,
  MultiQueryRetriever,
  MultiQueryTransformer,
  parseQueryPrompt,
  QueryTransformChain,
  REWRITE_PLACEHOLDERS,
  RrfFusion,
} from "../strategies/index.js";

export const REWRITE_PROMPT_FILE = "rewrite-question.v1.txt";
export const HYDE_PROMPT_FILE = "hyde.v1.txt";
export const MULTI_QUERY_PROMPT_FILE = "multi-query.v1.txt";

type QueryTransformSettings = RagConfig["queryTransform"];

export interface QueryTransformContext {
  /** The model that rewrites. By default the one that answers. */
  readonly llm: LlmProvider;
  /** Where the prompt files are. */
  readonly promptsDir: string;
}

async function readPrompt(
  dir: string,
  file: string,
  placeholders: readonly string[],
): Promise<PromptTemplate> {
  let text: string;
  try {
    text = await readFile(path.join(dir, file), "utf8");
  } catch (cause) {
    throw new RagError("CONFIG_INVALID", `Cannot read the prompt file ${path.join(dir, file)}`, {
      cause,
    });
  }
  return parseQueryPrompt(file, text, placeholders);
}

/**
 * The one place that reads `queryTransform.rewrite`, `.hyde` and `.multiQuery` for the transform
 * stage. It returns a single `QueryTransformer`: the identity when nothing is on, the transformer
 * itself when one is, a chain when several are. The pipeline cannot tell which.
 *
 * The rewriter goes first, so the others work on a standalone question. Only the prompt files of
 * the transformers that are on are read.
 *
 * @throws RagError CONFIG_INVALID if a prompt file is missing; INVALID_ARGUMENT if it is malformed
 */
export async function buildQueryTransformer(
  settings: QueryTransformSettings,
  context: QueryTransformContext,
): Promise<QueryTransformer> {
  const { llm, promptsDir } = context;
  const transformers: QueryTransformer[] = [];

  if (settings.rewrite) {
    transformers.push(
      new FollowUpRewriter({
        llm,
        prompt: await readPrompt(promptsDir, REWRITE_PROMPT_FILE, REWRITE_PLACEHOLDERS),
        maxTurns: settings.historyTurns,
      }),
    );
  }
  if (settings.multiQuery) {
    transformers.push(
      new MultiQueryTransformer({
        llm,
        prompt: await readPrompt(promptsDir, MULTI_QUERY_PROMPT_FILE, MULTI_QUERY_PLACEHOLDERS),
        count: settings.multiQueryCount,
      }),
    );
  }
  if (settings.hyde) {
    transformers.push(
      new HydeTransformer({
        llm,
        prompt: await readPrompt(promptsDir, HYDE_PROMPT_FILE, HYDE_PLACEHOLDERS),
      }),
    );
  }

  if (transformers.length === 0) return new IdentityQueryTransformer();
  return transformers.length === 1
    ? (transformers[0] as QueryTransformer)
    : new QueryTransformChain(transformers);
}

/**
 * Makes the retriever search for the extra texts a transformer adds (`Query.variants`). Only wrapped
 * when HyDE or multi-query is on: otherwise nothing would ever set a variant. Rankings are merged
 * with RRF, which needs no scale between searches.
 */
export function withVariantSearch(
  retriever: Retriever,
  settings: QueryTransformSettings,
): Retriever {
  return settings.hyde || settings.multiQuery
    ? new MultiQueryRetriever({ inner: retriever, fusion: new RrfFusion() })
    : retriever;
}

import type {
  LlmProvider,
  PromptTemplate,
  Query,
  QueryTransformer,
  TransformOptions,
} from "../../core/index.js";
import { RagError } from "../../shared/index.js";
import { completeText } from "./complete-text.js";
import { fillQueryPrompt } from "./query-prompt.js";

/** Placeholders of the multi-query prompt, each exactly once. */
export const MULTI_QUERY_PLACEHOLDERS = ["count", "question"] as const;

const MAX_VARIANT_TOKENS = 250;
const MAX_VARIANT_CHARS = 300;
const LIST_MARK = /^\s*(?:[-*•]|\d+[.)])\s*/;

export interface MultiQueryTransformerOptions {
  readonly llm: LlmProvider;
  /** Has `{{count}}` and `{{question}}` (see `MULTI_QUERY_PLACEHOLDERS`). */
  readonly prompt: PromptTemplate;
  /** How many other phrasings to ask for. A whole number of 1 or more. */
  readonly count: number;
}

/**
 * Asks the model for other ways to phrase the question and puts them in `query.variants`. A single
 * phrasing can miss a passage that uses other words ("cost" against "price"); several together
 * cover more. Only `variants` is set. Searching for each of them and merging the rankings is the
 * `MultiQueryRetriever`, so this class stays a plain transformer and `text` is untouched.
 *
 * The model's lines are cleaned (list marks removed, blank lines, copies of the question and
 * repeats dropped) and cut to `count`. If none is usable the query passes through. It costs one
 * model call per question, and the retriever then searches `count + 1` times.
 */
export class MultiQueryTransformer implements QueryTransformer {
  readonly name = "multi-query";

  readonly #llm: LlmProvider;
  readonly #prompt: PromptTemplate;
  readonly #count: number;

  /** @throws RagError INVALID_ARGUMENT if `count` is not a whole number of 1 or more */
  constructor(options: MultiQueryTransformerOptions) {
    if (!Number.isInteger(options.count) || options.count < 1) {
      throw new RagError(
        "INVALID_ARGUMENT",
        `count must be a whole number of 1 or more, got ${String(options.count)}`,
      );
    }
    this.#llm = options.llm;
    this.#prompt = options.prompt;
    this.#count = options.count;
  }

  async transform(query: Query, options: TransformOptions = {}): Promise<Query> {
    const question = query.text.trim();
    if (question === "") {
      throw new RagError("INVALID_ARGUMENT", "The question is blank");
    }
    const reply = await completeText(
      this.#llm,
      fillQueryPrompt(this.#prompt, { count: this.#count.toString(), question }),
      { maxOutputTokens: MAX_VARIANT_TOKENS, signal: options.signal },
    );

    const seen = new Set([question.toLowerCase(), ...(query.variants ?? []).map(lower)]);
    const fresh: string[] = [];
    for (const line of reply.split("\n")) {
      const variant = line.replace(LIST_MARK, "").trim().slice(0, MAX_VARIANT_CHARS);
      if (variant === "" || seen.has(variant.toLowerCase())) continue;
      seen.add(variant.toLowerCase());
      fresh.push(variant);
      if (fresh.length === this.#count) break;
    }
    return fresh.length === 0
      ? query
      : { ...query, variants: [...(query.variants ?? []), ...fresh] };
  }
}

const lower = (text: string): string => text.toLowerCase();

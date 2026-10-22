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

/** Placeholders of the HyDE prompt, each exactly once. */
export const HYDE_PLACEHOLDERS = ["question"] as const;

const MAX_PASSAGE_TOKENS = 200;
const MAX_PASSAGE_CHARS = 1500;

export interface HydeTransformerOptions {
  readonly llm: LlmProvider;
  /** Has `{{question}}` (see `HYDE_PLACEHOLDERS`). */
  readonly prompt: PromptTemplate;
}

/**
 * HyDE, "hypothetical document embeddings" (Gao et al., 2022). A question and the passage that
 * answers it do not look alike: one is short and asks, the other is long and states. So the model
 * first writes a passage that *could* answer the question, and that passage is what gets searched
 * for. It does not have to be right, only to sound like the book, because its words and its
 * meaning land near the real passage.
 *
 * The passage is added to `query.variants`, not put into `text`: `text` is also the question the
 * answering model is asked, and an invented passage must never reach it. The `MultiQueryRetriever`
 * searches for the question and for the passage and fuses the two rankings, so the user's own words
 * (good for a keyword retriever) and the passage's meaning (good for a dense one) both count. If
 * the model writes nothing, the query passes through. It costs one model call per question.
 */
export class HydeTransformer implements QueryTransformer {
  readonly name = "hyde";

  readonly #llm: LlmProvider;
  readonly #prompt: PromptTemplate;

  constructor(options: HydeTransformerOptions) {
    this.#llm = options.llm;
    this.#prompt = options.prompt;
  }

  async transform(query: Query, options: TransformOptions = {}): Promise<Query> {
    const question = query.text.trim();
    if (question === "") {
      throw new RagError("INVALID_ARGUMENT", "The question is blank");
    }
    const passage = (
      await completeText(this.#llm, fillQueryPrompt(this.#prompt, { question }), {
        maxOutputTokens: MAX_PASSAGE_TOKENS,
        signal: options.signal,
      })
    )
      .replace(/\s+/g, " ")
      .slice(0, MAX_PASSAGE_CHARS)
      .trim();
    return passage === "" ? query : { ...query, variants: [...(query.variants ?? []), passage] };
  }
}

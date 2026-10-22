import type {
  ConversationTurn,
  LlmProvider,
  PromptTemplate,
  Query,
  QueryTransformer,
  TransformOptions,
} from "../../core/index.js";
import { RagError } from "../../shared/index.js";
import { completeText } from "./complete-text.js";
import { fillQueryPrompt } from "./query-prompt.js";

/** Placeholders of the rewrite prompt, each exactly once. */
export const REWRITE_PLACEHOLDERS = ["history", "question"] as const;

const MAX_REWRITE_TOKENS = 200;
/** An answer is only context for resolving "it"; a long one is cut to keep the prompt small. */
const MAX_ANSWER_CHARS = 400;
/** A rewrite longer than this is the model rambling, not a question. */
const MAX_REWRITE_CHARS = 500;

const CITATION_MARKS = /\[\d+(?:\s*,\s*\d+)*\]/g;
const LABEL = /^(?:standalone question|rewritten question|question)\s*:\s*/i;

export interface FollowUpRewriterOptions {
  readonly llm: LlmProvider;
  /** Has `{{history}}` and `{{question}}` (see `REWRITE_PLACEHOLDERS`). */
  readonly prompt: PromptTemplate;
  /** How many of the latest turns the model sees. A whole number of 1 or more. */
  readonly maxTurns: number;
}

/**
 * Turns a follow-up into a question that stands alone. "What about chapter 4?" means nothing to a
 * retriever: it embeds those words and finds passages about chapters in general. Given the last few
 * turns, the model can say "What does chapter 4 say about chunking?", which retrieves the right
 * thing.
 *
 * - The first question of a conversation has no history, so it passes through and no model is
 *   called.
 * - Only the latest `maxTurns` turns are sent, with the citation marks taken out of the answers
 *   (`[2]` pointed into a prompt that is gone) and long answers cut short.
 * - A reply that is empty or absurdly long is not trusted: the original question is used, so a
 *   weak model makes retrieval no better, never worse.
 * - Everything else on the query (`history`, `variants`) is kept for the transformers after this.
 */
export class FollowUpRewriter implements QueryTransformer {
  readonly name = "rewrite";

  readonly #llm: LlmProvider;
  readonly #prompt: PromptTemplate;
  readonly #maxTurns: number;

  /** @throws RagError INVALID_ARGUMENT if `maxTurns` is not a whole number of 1 or more */
  constructor(options: FollowUpRewriterOptions) {
    if (!Number.isInteger(options.maxTurns) || options.maxTurns < 1) {
      throw new RagError(
        "INVALID_ARGUMENT",
        `maxTurns must be a whole number of 1 or more, got ${String(options.maxTurns)}`,
      );
    }
    this.#llm = options.llm;
    this.#prompt = options.prompt;
    this.#maxTurns = options.maxTurns;
  }

  async transform(query: Query, options: TransformOptions = {}): Promise<Query> {
    if (query.text.trim() === "") {
      throw new RagError("INVALID_ARGUMENT", "The question is blank");
    }
    const turns = (query.history ?? []).slice(-this.#maxTurns);
    if (turns.length === 0) return query;

    const reply = await completeText(
      this.#llm,
      fillQueryPrompt(this.#prompt, {
        history: formatHistory(turns),
        question: query.text.trim(),
      }),
      { maxOutputTokens: MAX_REWRITE_TOKENS, signal: options.signal },
    );
    const rewritten = cleanRewrite(reply);
    return rewritten === undefined ? query : { ...query, text: rewritten };
  }
}

/** The turns as the prompt shows them, oldest first. */
export function formatHistory(turns: readonly ConversationTurn[]): string {
  return turns
    .map(
      (turn) => `Q: ${oneLine(turn.question)}\nA: ${cut(oneLine(turn.answer), MAX_ANSWER_CHARS)}`,
    )
    .join("\n");
}

function oneLine(text: string): string {
  return text.replace(CITATION_MARKS, "").replace(/\s+/g, " ").trim();
}

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** The question in a model's reply, or undefined when the reply is not usable. */
function cleanRewrite(reply: string): string | undefined {
  const firstLine = reply.split("\n").find((line) => line.trim() !== "") ?? "";
  const unlabelled = firstLine.trim().replace(LABEL, "");
  const unquoted = unlabelled.replace(/^["'“‘]+|["'”’]+$/g, "").trim();
  if (unquoted === "" || unquoted.length > MAX_REWRITE_CHARS) return undefined;
  return unquoted;
}

import type {
  ChatMessage,
  LlmProvider,
  PromptTemplate,
  Query,
  RerankOptions,
  Reranker,
  RetrievedChunk,
} from "../../core/index.js";
import { noopLogger, RagError } from "../../shared/index.js";
import type { Logger } from "../../shared/index.js";
import { assertRerankArguments } from "./noop-reranker.js";
import { fillRerankPrompt } from "./rerank-prompt.js";
import { runLimited } from "./run-limited.js";
import { parseScoreReply } from "./score-reply.js";

export const DEFAULT_CONCURRENCY = 4;
/** The answer is a short JSON object. A model that needs more than this is not following the prompt. */
const MAX_REPLY_TOKENS = 60;
const RETRY_REMINDER =
  'That was not a valid answer. Reply with only a JSON object like {"score": 7}, where the score is a number from 0 to 10.';

export interface LlmRerankerOptions {
  /** The model that judges. It is used through the port: nothing here knows it is Ollama. */
  readonly llm: LlmProvider;
  /** The relevance prompt, with `{{question}}` and `{{passage}}` (see `parseRerankPrompt`). */
  readonly prompt: PromptTemplate;
  /** Most requests in flight at once. A whole number of 1 or more. Default 4. */
  readonly concurrency?: number;
  readonly logger?: Logger;
}

/** Why the candidates could not all be scored. */
class ScoringFailed extends Error {}

/**
 * Reorders candidates by asking a language model how well each one answers the question.
 *
 * It is **pointwise**: one small request per candidate ("question and passage: score 0 to 10"),
 * not one request that shows the model every candidate. Each judgement is independent of how many
 * candidates there are and of their order, a short prompt suits a small local model, and the requests
 * run side by side, at most `concurrency` at a time.
 *
 * - The reply must be a JSON object `{"score": n}` with `n` from 0 to 10, checked with a schema. An
 *   invalid reply is asked for again once, with a reminder of the format.
 * - The best `k` by score are returned, ties in the retriever's order. The returned `score` is the
 *   model's 0 to 10 score: the retriever's old scores would not descend along the new order, and
 *   scores of two different scales are not comparable anyway.
 * - **It never makes things worse than not reranking.** If any candidate cannot be scored (the
 *   server is down, the model answers badly twice) the whole list falls back to the retriever's
 *   order and scores, cut to `k`, and the reason is logged. A list that is half judged and half not
 *   cannot be compared fairly. When the server fails, the requests still running are cancelled, so
 *   a dead server costs one timeout, not twenty.
 * - The model is asked with temperature 0 and a small output limit. The passage is quoted text and
 *   the prompt says so, but a model can still be swayed by it: the worst a hostile passage can do
 *   here is raise its own score, and it can never change what is retrieved or answered.
 */
export class LlmReranker implements Reranker {
  readonly name = "llm";

  readonly #llm: LlmProvider;
  readonly #prompt: PromptTemplate;
  readonly #concurrency: number;
  readonly #logger: Logger;

  /** @throws RagError CONFIG_INVALID if `concurrency` is not a whole number of 1 or more */
  constructor(options: LlmRerankerOptions) {
    const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new RagError(
        "CONFIG_INVALID",
        `LlmReranker: concurrency must be a whole number of 1 or more, got ${String(concurrency)}`,
      );
    }
    this.#llm = options.llm;
    this.#prompt = options.prompt;
    this.#concurrency = concurrency;
    this.#logger = options.logger ?? noopLogger;
  }

  async rerank(
    query: Query,
    candidates: readonly RetrievedChunk[],
    options: RerankOptions,
  ): Promise<readonly RetrievedChunk[]> {
    assertRerankArguments(query, options);
    if (candidates.length === 0) return [];

    const stop = new AbortController();
    let cause: unknown;
    let scores: number[];
    try {
      scores = await runLimited(candidates, this.#concurrency, async (candidate) => {
        try {
          return await this.#score(query.text, candidate, stop.signal);
        } catch (error) {
          // remembered before the others are cancelled, so their AbortErrors cannot replace it
          cause ??= error;
          stop.abort();
          throw error;
        }
      });
    } catch {
      this.#logger.warn("llm rerank failed, keeping the retriever's order", {
        model: this.#llm.modelId,
        prompt: `${this.#prompt.id}@${this.#prompt.version}`,
        candidates: candidates.length,
        reason: describe(cause),
      });
      return candidates.slice(0, options.k);
    }

    return candidates
      .map((candidate, index) => ({ candidate, score: scores[index] ?? 0, index }))
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .slice(0, options.k)
      .map(({ candidate, score }, position) => ({ ...candidate, score, rank: position + 1 }));
  }

  /** The model's score for one candidate: asks, and asks once more if the reply is not valid. */
  async #score(question: string, candidate: RetrievedChunk, signal: AbortSignal): Promise<number> {
    const first: ChatMessage[] = [
      { role: "user", content: fillRerankPrompt(this.#prompt, question, candidate.chunk.text) },
    ];
    const reply = await this.#ask(first, signal);
    const score = parseScoreReply(reply);
    if (score !== undefined) return score;

    const again = await this.#ask(
      [
        ...first,
        { role: "assistant", content: reply === "" ? "(no reply)" : reply },
        { role: "user", content: RETRY_REMINDER },
      ],
      signal,
    );
    const retried = parseScoreReply(again);
    if (retried !== undefined) return retried;
    throw new ScoringFailed(`chunk ${candidate.chunk.id}: no valid score after a second try`);
  }

  async #ask(messages: readonly ChatMessage[], signal: AbortSignal): Promise<string> {
    let reply = "";
    for await (const delta of this.#llm.chat(messages, {
      temperature: 0,
      maxOutputTokens: MAX_REPLY_TOKENS,
      signal,
    })) {
      if (delta.kind === "text") reply += delta.text;
    }
    return reply;
  }
}

function describe(cause: unknown): string {
  if (cause instanceof RagError) return `${cause.code}: ${cause.message}`;
  return cause instanceof Error ? cause.message : String(cause);
}

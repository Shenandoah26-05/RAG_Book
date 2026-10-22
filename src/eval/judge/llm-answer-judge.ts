import { z } from "zod";
import type {
  AnswerJudge,
  AnswerJudgement,
  ChatMessage,
  FaithfulnessJudgement,
  JudgeInput,
  LlmProvider,
  PromptTemplate,
  ScoredJudgement,
} from "../../core/index.js";
import { RagError } from "../../shared/index.js";
import { fillJudgePrompt } from "./judge-prompt.js";
import type { JudgeMetric } from "./judge-prompt.js";
import { parseReply } from "./judge-reply.js";

/** A list of claims can be long; a verdict is one sentence and one word. */
const MAX_CLAIMS_TOKENS = 700;
const MAX_VERDICT_TOKENS = 150;
const RETRY_REMINDER =
  "That was not a valid answer. Reply with only the JSON object described above, and no other text.";

const claimsReply = z.object({
  claims: z.array(z.object({ claim: z.string(), supported: z.boolean() })),
});

/**
 * Three verdicts, not a number on a scale: a small model is steadier choosing between words. Each
 * verdict maps to a score of 1, 0.5 or 0.
 */
const RELEVANCE = { answers: 1, partly: 0.5, "off-topic": 0 } as const;
const CORRECTNESS = { correct: 1, partial: 0.5, incorrect: 0 } as const;

const relevanceReply = z.object({
  reason: z.string(),
  verdict: z.enum(["answers", "partly", "off-topic"]),
});
const correctnessReply = z.object({
  reason: z.string(),
  verdict: z.enum(["correct", "partial", "incorrect"]),
});

export interface LlmAnswerJudgeOptions {
  /**
   * The model that judges. Configure it apart from the generator (`judge.*`): a model grading its
   * own answers is lenient with them. Used through the port; nothing here knows it is Ollama.
   */
  readonly llm: LlmProvider;
  readonly prompts: Readonly<Record<JudgeMetric, PromptTemplate>>;
}

/**
 * Scores an answer by asking a language model three separate questions, each with its own prompt:
 *
 * - **faithfulness**: split the answer into claims and mark each supported or not by the sources;
 *   the score is the supported share. An answer with no claim (a refusal) has no score, not 0 or 1.
 * - **relevance**: does the answer address the question, right or wrong.
 * - **correctness**: does it agree with the reference answer.
 *
 * Three narrow questions beat one broad one: a small model gets one thing to decide at a time, and
 * a bad score can be traced to one prompt.
 *
 * The judge is **just another `LlmProvider` consumer**, like the LLM reranker. It asks at
 * temperature 0, reads a JSON reply checked with a schema, and asks once more with a reminder if
 * the reply is not valid. It then throws instead of guessing: a made-up score looks like a
 * measurement. Whoever runs the evaluation decides what a failed question means.
 *
 * Biases of an LLM judge, and what is done about each (see docs/design/rag-082-generation-metrics.md):
 * leniency toward its own writing (use another model), preference for long or confident answers
 * (the prompts say not to), and being swayed by text inside the answer (it is quoted, and the
 * prompts call it material, not instructions).
 */
export class LlmAnswerJudge implements AnswerJudge {
  readonly #llm: LlmProvider;
  readonly #prompts: Readonly<Record<JudgeMetric, PromptTemplate>>;

  constructor(options: LlmAnswerJudgeOptions) {
    this.#llm = options.llm;
    this.#prompts = options.prompts;
  }

  get modelId(): string {
    return this.#llm.modelId;
  }

  /**
   * @throws RagError INVALID_ARGUMENT for a blank question or answer; PROVIDER_UNAVAILABLE if the
   * model cannot be reached or gives no valid reply twice; the signal's reason if it is aborted
   */
  async judge(input: JudgeInput, signal?: AbortSignal): Promise<AnswerJudgement> {
    if (input.question.trim() === "") {
      throw new RagError("INVALID_ARGUMENT", "The question to judge is blank");
    }
    if (input.answer.trim() === "") {
      throw new RagError("INVALID_ARGUMENT", "The answer to judge is blank");
    }
    // one at a time: a local model serves one request at a time anyway
    const faithfulness = await this.#faithfulness(input, signal);
    const relevance = await this.#verdict("relevance", relevanceReply, RELEVANCE, input, signal);
    const correctness = await this.#verdict(
      "correctness",
      correctnessReply,
      CORRECTNESS,
      input,
      signal,
    );
    return {
      faithfulness,
      relevance,
      correctness,
      judgeModel: this.#llm.modelId,
      promptVersions: (["faithfulness", "relevance", "correctness"] as const).map(
        (metric) => `${this.#prompts[metric].id}@${this.#prompts[metric].version}`,
      ),
    };
  }

  async #faithfulness(input: JudgeInput, signal?: AbortSignal): Promise<FaithfulnessJudgement> {
    const sources =
      input.sources.length === 0
        ? "(no sources)"
        : input.sources.map((text, i) => `[${(i + 1).toString()}] ${text.trim()}`).join("\n\n");
    const prompt = fillJudgePrompt(this.#prompts.faithfulness, { sources, answer: input.answer });
    const { claims } = await this.#askJson(
      "faithfulness",
      prompt,
      claimsReply,
      MAX_CLAIMS_TOKENS,
      signal,
    );
    if (claims.length === 0) return { score: undefined, claims };
    return { score: claims.filter((c) => c.supported).length / claims.length, claims };
  }

  async #verdict<V extends string>(
    metric: "relevance" | "correctness",
    schema: z.ZodType<{ reason: string; verdict: V }>,
    scores: Readonly<Record<V, number>>,
    input: JudgeInput,
    signal?: AbortSignal,
  ): Promise<ScoredJudgement> {
    const prompt = fillJudgePrompt(this.#prompts[metric], {
      question: input.question,
      answer: input.answer,
      reference: input.reference,
    });
    const reply = await this.#askJson(metric, prompt, schema, MAX_VERDICT_TOKENS, signal);
    return { score: scores[reply.verdict], reason: reply.reason.trim() };
  }

  /** Asks, and asks once more with a reminder if the reply is not JSON of the right shape. */
  async #askJson<T>(
    metric: JudgeMetric,
    prompt: string,
    schema: z.ZodType<T>,
    maxOutputTokens: number,
    signal?: AbortSignal,
  ): Promise<T> {
    const first: ChatMessage[] = [{ role: "user", content: prompt }];
    const reply = await this.#ask(first, maxOutputTokens, signal);
    const parsed = parseReply(reply, schema);
    if (parsed !== undefined) return parsed;

    const again = await this.#ask(
      [
        ...first,
        { role: "assistant", content: reply === "" ? "(no reply)" : reply },
        { role: "user", content: RETRY_REMINDER },
      ],
      maxOutputTokens,
      signal,
    );
    const retried = parseReply(again, schema);
    if (retried !== undefined) return retried;
    throw new RagError(
      "PROVIDER_UNAVAILABLE",
      `The judge model ${this.#llm.modelId} gave no valid ${metric} reply after a second try`,
    );
  }

  async #ask(
    messages: readonly ChatMessage[],
    maxOutputTokens: number,
    signal?: AbortSignal,
  ): Promise<string> {
    let reply = "";
    for await (const delta of this.#llm.chat(messages, {
      temperature: 0,
      maxOutputTokens,
      ...(signal === undefined ? {} : { signal }),
    })) {
      if (delta.kind === "text") reply += delta.text;
    }
    return reply;
  }
}

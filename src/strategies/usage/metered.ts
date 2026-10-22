import type {
  ChatDelta,
  ChatMessage,
  ChatOptions,
  EmbedKind,
  Embedder,
  LlmProvider,
} from "../../core/index.js";
import {
  currentTrace,
  EMBED_CALL_STAGE,
  MODEL_CALL_STAGE,
  systemClock,
} from "../../shared/index.js";
import type { Clock, Trace } from "../../shared/index.js";

export interface MeteredOptions {
  /** Times the first piece of a reply. Replaced in tests. */
  readonly clock?: Clock;
}

/** The characters per token that `ApproxTokenizer` assumes, for counting what an embedder was sent. */
const CHARS_PER_TOKEN = 4;

/**
 * Records every call to a model on the trace of the question being answered: which model, the tokens
 * sent and written (as the provider reports them), how long until the first piece, and how long in
 * all. One decorator sees every use of the model, not only the answer: the reranker, query rewriting
 * and the judge all call a provider built by the same builder.
 *
 * - It records on `currentTrace()`, **read when `chat` is called**: the reply is a lazily-run
 *   stream, and by the time it is read the scope that held the trace is gone.
 * - With no trace in scope (a call outside a question) it does nothing and returns the model's own
 *   stream, so metering is free to leave on everywhere.
 * - It records what the caller experienced, so it goes outside retrying and rate limiting: the time
 *   includes waits for a turn and between retries, and a call that was retried is one call.
 * - A failed or abandoned call is recorded too, with `completed: false`, so the cost of a stopped
 *   answer is not lost.
 */
export class MeteredProvider implements LlmProvider {
  readonly #inner: LlmProvider;
  readonly #clock: Clock;

  constructor(inner: LlmProvider, options: MeteredOptions = {}) {
    this.#inner = inner;
    this.#clock = options.clock ?? systemClock;
  }

  get modelId(): string {
    return this.#inner.modelId;
  }

  chat(messages: readonly ChatMessage[], options?: ChatOptions): AsyncIterable<ChatDelta> {
    const trace = currentTrace();
    if (trace === undefined) return this.#inner.chat(messages, options);
    return this.#recorded(trace, messages, options);
  }

  async *#recorded(
    trace: Trace,
    messages: readonly ChatMessage[],
    options: ChatOptions | undefined,
  ): AsyncGenerator<ChatDelta> {
    const stage = trace.start(MODEL_CALL_STAGE);
    const started = this.#clock.now();
    let firstTokenMs: number | undefined;
    let end: Extract<ChatDelta, { kind: "end" }> | undefined;
    let characters = 0;
    let failed = false;
    const summary = (): Record<string, string | number | boolean | null> => ({
      model: this.#inner.modelId,
      promptTokens: end?.promptTokens ?? null,
      outputTokens: end?.outputTokens ?? null,
      firstTokenMs: firstTokenMs ?? null,
      characters,
      completed: end !== undefined,
    });
    try {
      for await (const delta of this.#inner.chat(messages, options)) {
        if (delta.kind === "text") {
          firstTokenMs ??= this.#clock.now() - started;
          characters += delta.text.length;
        } else {
          end = delta;
        }
        yield delta;
      }
    } catch (error) {
      failed = true;
      stage.fail(error, summary());
      throw error;
    } finally {
      // also reached when the reader stops early: the call is then recorded as not completed
      if (!failed) stage.end(summary());
    }
  }
}

/**
 * Records every call to an embedder on the trace: the model, how many texts, and how many tokens
 * they come to. An embedder does not say how many tokens it was sent, so the count is an estimate
 * from the characters (marked `estimated`), which is close enough to price a hosted embedding model.
 *
 * It goes **inside the cache**, so a vector that was already cached is not a call and costs nothing.
 */
export class MeteredEmbedder implements Embedder {
  readonly #inner: Embedder;

  constructor(inner: Embedder) {
    this.#inner = inner;
  }

  get modelId(): string {
    return this.#inner.modelId;
  }

  get dimensions(): number {
    return this.#inner.dimensions;
  }

  async embed(texts: readonly string[], kind: EmbedKind): Promise<readonly Float32Array[]> {
    const trace = currentTrace();
    if (trace === undefined || texts.length === 0) return this.#inner.embed(texts, kind);
    const characters = texts.reduce((sum, text) => sum + text.length, 0);
    const summary = {
      model: this.#inner.modelId,
      texts: texts.length,
      kind,
      promptTokens: Math.ceil(characters / CHARS_PER_TOKEN),
      estimated: true,
    };
    const stage = trace.start(EMBED_CALL_STAGE);
    try {
      const vectors = await this.#inner.embed(texts, kind);
      stage.end(summary);
      return vectors;
    } catch (error) {
      stage.fail(error, summary);
      throw error;
    }
  }
}

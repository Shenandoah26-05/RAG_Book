import { z } from "zod";
import type { ChatDelta, ChatMessage, ChatOptions, LlmProvider } from "../../core/index.js";
import { RagError } from "../../shared/index.js";

const DEFAULT_IDLE_TIMEOUT_MS = 120_000;

export interface OllamaProviderOptions {
  /** Base URL of the server, e.g. `OllamaHost.address`. */
  readonly address: string;
  /** Model name as Ollama knows it, e.g. "llama3.2". */
  readonly model: string;
  /** Used when a `chat` call does not set its own. */
  readonly temperature?: number;
  /** Used when a `chat` call does not set its own. */
  readonly maxOutputTokens?: number;
  /**
   * How long the server may stay silent, before the first piece and between pieces, before the
   * request is given up. Default 2 minutes: loading a model into memory can take a while.
   */
  readonly idleTimeoutMs?: number;
  readonly fetch?: typeof fetch;
}

/** One line of the NDJSON reply of `POST /api/chat`; extra fields are ignored. */
const replyLine = z.object({
  message: z.object({ content: z.string() }).optional(),
  done: z.boolean().optional(),
  done_reason: z.string().optional(),
  prompt_eval_count: z.number().optional(),
  eval_count: z.number().optional(),
  error: z.string().optional(),
});

const unavailable = (message: string, cause?: unknown): RagError =>
  new RagError("PROVIDER_UNAVAILABLE", message, cause === undefined ? {} : { cause });

const wholeNumber = (name: string, value: number): void => {
  if (!Number.isInteger(value) || value < 1) {
    throw new RagError(
      "CONFIG_INVALID",
      `OllamaProvider: ${name} must be a whole number of 1 or more, got ${String(value)}`,
    );
  }
};

/**
 * Chats with a model served by Ollama (`/api/chat`). The only file that knows Ollama's chat format.
 *
 * Ollama answers with one JSON object per line while the model writes. Network chunks do not
 * respect line or even character boundaries, so the bytes are decoded as a stream and cut into
 * lines here. The request is not retried: once text has reached the caller a second attempt would
 * repeat it, and the caller decides whether to ask again.
 */
export class OllamaProvider implements LlmProvider {
  readonly modelId: string;

  readonly #address: string;
  readonly #model: string;
  readonly #temperature: number | undefined;
  readonly #maxOutputTokens: number | undefined;
  readonly #idleTimeoutMs: number;
  readonly #fetch: typeof fetch;

  /** @throws RagError CONFIG_INVALID if a setting is not a usable number */
  constructor(options: OllamaProviderOptions) {
    const idle = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    wholeNumber("idleTimeoutMs", idle);
    if (options.maxOutputTokens !== undefined) {
      wholeNumber("maxOutputTokens", options.maxOutputTokens);
    }
    if (
      options.temperature !== undefined &&
      (!Number.isFinite(options.temperature) || options.temperature < 0)
    ) {
      throw new RagError(
        "CONFIG_INVALID",
        `OllamaProvider: temperature must be 0 or more, got ${String(options.temperature)}`,
      );
    }
    this.modelId = `ollama:${options.model}`;
    this.#address = options.address;
    this.#model = options.model;
    this.#temperature = options.temperature;
    this.#maxOutputTokens = options.maxOutputTokens;
    this.#idleTimeoutMs = idle;
    this.#fetch = options.fetch ?? fetch;
  }

  async *chat(
    messages: readonly ChatMessage[],
    options: ChatOptions = {},
  ): AsyncGenerator<ChatDelta, void, undefined> {
    if (messages.length === 0) {
      throw new RagError("INVALID_ARGUMENT", "chat needs at least one message");
    }
    const caller = options.signal;
    caller?.throwIfAborted();

    // one controller for the request: it fires when the caller aborts or the server goes quiet
    const request = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const state = { stalled: false };
    const restartTimer = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        state.stalled = true;
        request.abort();
      }, this.#idleTimeoutMs);
    };
    const onCallerAbort = (): void => {
      request.abort();
    };
    caller?.addEventListener("abort", onCallerAbort, { once: true });

    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      restartTimer();
      const response = await this.#send(messages, options, request.signal);
      if (response.body === null) throw unavailable(`Ollama at ${this.#address} sent no body`);
      reader = response.body.getReader();

      const decoder = new TextDecoder();
      let pending = "";
      let ended = false;
      for (;;) {
        const { done, value } = await reader.read();
        // a body that does not fail by itself on abort must still stop the loop
        request.signal.throwIfAborted();
        restartTimer();
        pending += decoder.decode(value, { stream: !done });
        const lines = pending.split("\n");
        pending = done ? "" : (lines.pop() ?? "");
        for (const text of lines) {
          if (text.trim() === "") continue;
          const delta = this.#parse(text);
          if (ended) throw unavailable(`Ollama at ${this.#address} kept writing after the end`);
          if (delta === undefined) continue;
          if (delta.kind === "end") ended = true;
          yield delta;
        }
        if (done) break;
      }
      if (!ended) {
        throw unavailable(`Ollama at ${this.#address} closed the stream before the reply was done`);
      }
    } catch (error) {
      if (caller?.aborted === true) throw caller.reason;
      if (state.stalled) {
        throw unavailable(
          `Ollama at ${this.#address} sent nothing for ${this.#idleTimeoutMs.toString()} ms`,
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
      caller?.removeEventListener("abort", onCallerAbort);
      // closes the connection when the caller stops early or something failed
      await reader?.cancel().catch(() => undefined);
    }
  }

  async #send(
    messages: readonly ChatMessage[],
    options: ChatOptions,
    signal: AbortSignal,
  ): Promise<Response> {
    const temperature = options.temperature ?? this.#temperature;
    const numPredict = options.maxOutputTokens ?? this.#maxOutputTokens;
    const modelOptions = {
      ...(temperature === undefined ? {} : { temperature }),
      ...(numPredict === undefined ? {} : { num_predict: numPredict }),
    };
    let response: Response;
    try {
      response = await this.#fetch(`${this.#address}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.#model,
          messages: messages.map(({ role, content }) => ({ role, content })),
          stream: true,
          options: modelOptions,
        }),
        signal,
      });
    } catch (cause) {
      // an abort is turned into the right error by `chat`, which knows who asked for it
      if (signal.aborted) throw cause;
      throw unavailable(`Cannot reach Ollama at ${this.#address}`, cause);
    }
    if (response.ok) return response;
    const detail = await errorDetail(response);
    throw unavailable(
      response.status === 404
        ? `Ollama at ${this.#address} has no model "${this.#model}" (${detail}). Run: ollama pull ${this.#model}`
        : `Ollama at ${this.#address} answered with HTTP ${response.status.toString()} (${detail})`,
    );
  }

  /** One line of the reply as an event; `undefined` for a line with nothing to pass on. */
  #parse(text: string): ChatDelta | undefined {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (cause) {
      throw unavailable(
        `The server at ${this.#address} did not answer like Ollama's /api/chat (not JSON)`,
        cause,
      );
    }
    const parsed = replyLine.safeParse(json);
    if (!parsed.success) {
      throw unavailable(
        `The server at ${this.#address} did not answer like Ollama's /api/chat (unexpected response)`,
        parsed.error,
      );
    }
    const data = parsed.data;
    // Ollama reports a failure in the middle of a reply as a line of its own
    if (data.error !== undefined) {
      throw unavailable(`Ollama at ${this.#address} failed while answering: ${data.error}`);
    }
    if (data.done === true) {
      return {
        kind: "end",
        reason: data.done_reason === "length" ? "length" : "stop",
        ...(data.prompt_eval_count === undefined ? {} : { promptTokens: data.prompt_eval_count }),
        ...(data.eval_count === undefined ? {} : { outputTokens: data.eval_count }),
      };
    }
    const content = data.message?.content ?? "";
    return content === "" ? undefined : { kind: "text", text: content };
  }
}

async function errorDetail(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    const parsed = z.object({ error: z.string() }).safeParse(body);
    if (parsed.success) return parsed.data.error;
  } catch {
    // fall through to the status text
  }
  return response.statusText === "" ? "no details" : response.statusText;
}

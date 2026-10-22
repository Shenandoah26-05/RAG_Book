import { z } from "zod";
import type { ChatDelta, ChatMessage, ChatOptions, LlmProvider } from "../../core/index.js";
import { RagError } from "../../shared/index.js";
import type { OpenAiEndpoint } from "../openai-compatible/index.js";

const DEFAULT_IDLE_TIMEOUT_MS = 120_000;

export interface OpenAiChatProviderOptions {
  readonly endpoint: OpenAiEndpoint;
  /** Model name as the server knows it, e.g. "gpt-4o-mini". */
  readonly model: string;
  /** Used when a `chat` call does not set its own. */
  readonly temperature?: number;
  /** Used when a `chat` call does not set its own. */
  readonly maxOutputTokens?: number;
  /** How long the server may stay silent before the request is given up. Default 2 minutes. */
  readonly idleTimeoutMs?: number;
  readonly fetch?: typeof fetch;
}

/** One `data:` event of a streamed chat completion; extra fields are ignored. */
const chunk = z.object({
  choices: z
    .array(
      z.object({
        delta: z.object({ content: z.string().nullish() }).optional(),
        finish_reason: z.string().nullish(),
      }),
    )
    .optional(),
  usage: z
    .object({ prompt_tokens: z.number().optional(), completion_tokens: z.number().optional() })
    .nullish(),
  error: z.union([z.string(), z.object({ message: z.string() })]).optional(),
});

const wholeNumber = (name: string, value: number): void => {
  if (!Number.isInteger(value) || value < 1) {
    throw new RagError(
      "CONFIG_INVALID",
      `OpenAiChatProvider: ${name} must be a whole number of 1 or more, got ${String(value)}`,
    );
  }
};

/** What has been learned about the reply so far, to build the `end` event from. */
interface ReplyState {
  finishReason: string | undefined;
  promptTokens: number | undefined;
  outputTokens: number | undefined;
}

/**
 * Chats with any server that speaks OpenAI's `POST /chat/completions` (OpenAI, vLLM, LM Studio,
 * Ollama's `/v1`, gateways, ...). The only file that knows this chat format.
 *
 * The reply is a server-sent-events stream: lines `data: {json}` and a last `data: [DONE]`. Network
 * chunks cut lines anywhere, so the bytes are decoded as a stream and split into lines here. The
 * `end` event is sent at `[DONE]` (or when the stream closes after a finish reason, for servers that
 * leave `[DONE]` out) because the token counts arrive in a chunk after the finish reason.
 *
 * Like the Ollama provider it never retries (text may already have reached the caller; retries are
 * the job of a decorator) and its timeout counts silence, not total time.
 */
export class OpenAiChatProvider implements LlmProvider {
  readonly modelId: string;

  readonly #endpoint: OpenAiEndpoint;
  readonly #model: string;
  readonly #temperature: number | undefined;
  readonly #maxOutputTokens: number | undefined;
  readonly #idleTimeoutMs: number;
  readonly #fetch: typeof fetch;

  /** @throws RagError CONFIG_INVALID if a setting is not a usable number */
  constructor(options: OpenAiChatProviderOptions) {
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
        `OpenAiChatProvider: temperature must be 0 or more, got ${String(options.temperature)}`,
      );
    }
    this.modelId = `openai-compatible:${options.model}`;
    this.#endpoint = options.endpoint;
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
    const stalled = { value: false };
    const restartTimer = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        stalled.value = true;
        request.abort();
      }, this.#idleTimeoutMs);
    };
    const onCallerAbort = (): void => {
      request.abort();
    };
    caller?.addEventListener("abort", onCallerAbort, { once: true });

    const state: ReplyState = {
      finishReason: undefined,
      promptTokens: undefined,
      outputTokens: undefined,
    };
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      restartTimer();
      const response = await this.#send(messages, options, request.signal);
      if (response.body === null) throw this.#endpoint.notCompatible("no body");
      reader = response.body.getReader();

      const decoder = new TextDecoder();
      let pending = "";
      let finished = false;
      while (!finished) {
        const { done, value } = await reader.read();
        // a body that does not fail by itself on abort must still stop the loop
        request.signal.throwIfAborted();
        restartTimer();
        pending += decoder.decode(value, { stream: !done });
        const lines = pending.split("\n");
        pending = done ? "" : (lines.pop() ?? "");
        for (const line of lines) {
          const data = dataOf(line);
          if (data === undefined) continue;
          if (data === "[DONE]") {
            finished = true;
            break;
          }
          const text = this.#read(data, state);
          if (text !== "") yield { kind: "text", text };
        }
        if (done) break;
      }
      if (!finished && state.finishReason === undefined) {
        throw this.#endpoint.notCompatible("the stream closed before the reply was done");
      }
      yield {
        kind: "end",
        reason: state.finishReason === "length" ? "length" : "stop",
        ...(state.promptTokens === undefined ? {} : { promptTokens: state.promptTokens }),
        ...(state.outputTokens === undefined ? {} : { outputTokens: state.outputTokens }),
      };
    } catch (error) {
      if (caller?.aborted === true) throw caller.reason;
      if (stalled.value) {
        throw new RagError(
          "PROVIDER_UNAVAILABLE",
          `The server at ${this.#endpoint.baseUrl} sent nothing for ${this.#idleTimeoutMs.toString()} ms`,
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
    const maxTokens = options.maxOutputTokens ?? this.#maxOutputTokens;
    let response: Response;
    try {
      response = await this.#fetch(this.#endpoint.url("/chat/completions"), {
        method: "POST",
        headers: this.#endpoint.headers(),
        body: JSON.stringify({
          model: this.#model,
          messages: messages.map(({ role, content }) => ({ role, content })),
          stream: true,
          // asks for token counts in a last chunk; servers that do not know it ignore it
          stream_options: { include_usage: true },
          ...(temperature === undefined ? {} : { temperature }),
          ...(maxTokens === undefined ? {} : { max_tokens: maxTokens }),
        }),
        signal,
      });
    } catch (cause) {
      // an abort is turned into the right error by `chat`, which knows who asked for it
      if (signal.aborted) throw cause;
      throw this.#endpoint.unreachable(cause);
    }
    if (response.ok) return response;
    throw await this.#endpoint.httpError(response, this.#model);
  }

  /** Takes in one `data:` payload and returns the text it carries ("" if none). */
  #read(data: string, state: ReplyState): string {
    let json: unknown;
    try {
      json = JSON.parse(data);
    } catch (cause) {
      throw this.#endpoint.notCompatible("not JSON", cause);
    }
    const parsed = chunk.safeParse(json);
    if (!parsed.success) throw this.#endpoint.notCompatible("unexpected response", parsed.error);
    const event = parsed.data;
    // some servers report a failure in the middle of a reply as an event of its own
    if (event.error !== undefined) {
      const message = typeof event.error === "string" ? event.error : event.error.message;
      throw new RagError(
        "PROVIDER_UNAVAILABLE",
        `The server at ${this.#endpoint.baseUrl} failed while answering: ${this.#endpoint.redact(message)}`,
      );
    }
    if (event.usage != null) {
      state.promptTokens = event.usage.prompt_tokens ?? state.promptTokens;
      state.outputTokens = event.usage.completion_tokens ?? state.outputTokens;
    }
    const choice = event.choices?.[0];
    if (choice?.finish_reason != null) state.finishReason = choice.finish_reason;
    return choice?.delta?.content ?? "";
  }
}

/** The payload of a `data:` line; `undefined` for blank lines, comments and other fields. */
function dataOf(line: string): string | undefined {
  const text = line.endsWith("\r") ? line.slice(0, -1) : line;
  if (!text.startsWith("data:")) return undefined;
  const data = text.slice("data:".length).trim();
  return data === "" ? undefined : data;
}

import type { ChatDelta, ChatMessage, ChatOptions } from "../types/chat.js";

/**
 * A language model that answers a conversation. Every model host implements this.
 *
 * The reply is a **stream**: `chat` returns an async iterable, so a caller can show the answer as
 * it is written. A caller that wants the whole text just joins the `text` events. Streaming is part
 * of the port from the start because adding it later would change every caller.
 *
 * Rules every provider follows:
 * 1. The stream is `text` events (never empty) followed by exactly one `end` event, then it closes.
 * 2. `messages` must not be empty, otherwise the first read rejects with INVALID_ARGUMENT.
 * 3. Aborting `options.signal` stops the request and makes the stream throw the signal's reason
 *    (an `AbortError` by default). A signal that is already aborted never starts a request.
 * 4. A server that cannot be reached, that misses the model, or that answers badly rejects with a
 *    RagError coded PROVIDER_UNAVAILABLE, also when it fails in the middle of a reply.
 * 5. Stopping early (a `break` in `for await`) releases the connection.
 */
export interface LlmProvider {
  /** Identifies the model, e.g. "ollama:llama3.2". Goes into traces and eval reports. */
  readonly modelId: string;
  chat(messages: readonly ChatMessage[], options?: ChatOptions): AsyncIterable<ChatDelta>;
}

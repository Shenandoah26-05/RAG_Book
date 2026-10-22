// A language model that answers from a script, for tests of code that calls one. Not part of the
// build (see tsconfig.build.json).
import type { ChatDelta, ChatMessage, ChatOptions, LlmProvider } from "../core/index.js";

export interface ScriptedCall {
  readonly messages: readonly ChatMessage[];
  readonly options: ChatOptions | undefined;
  /** The text of the user message, which is how the transformers ask. */
  readonly prompt: string;
}

export interface ScriptedLlm extends LlmProvider {
  readonly calls: ScriptedCall[];
}

/**
 * Answers each call with the next reply (the last one repeats). The reply comes as two `text`
 * events so that joining the stream is exercised. An `Error` makes the stream throw.
 */
export function scriptedLlm(...replies: (string | Error)[]): ScriptedLlm {
  const calls: ScriptedCall[] = [];
  return {
    modelId: "fake:scripted",
    calls,
    chat(messages, options) {
      calls.push({ messages, options, prompt: messages.map((m) => m.content).join("\n") });
      const reply = replies[Math.min(calls.length - 1, replies.length - 1)] ?? "";
      return (async function* (): AsyncGenerator<ChatDelta> {
        await Promise.resolve();
        options?.signal?.throwIfAborted();
        if (reply instanceof Error) throw reply;
        const half = Math.ceil(reply.length / 2);
        for (const text of [reply.slice(0, half), reply.slice(half)]) {
          if (text !== "") yield { kind: "text", text };
        }
        yield { kind: "end", reason: "stop" };
      })();
    },
  };
}
